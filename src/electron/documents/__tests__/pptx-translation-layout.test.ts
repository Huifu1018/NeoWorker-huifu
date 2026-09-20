import { describe, expect, it } from "vitest";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { applyOfficeTranslation, inspectOfficeTranslation, verifyOfficeTranslationFidelity } from "../office-translation";
import { fitPptxTranslation, findNewTextCollisions, type TextFitBox, type TextFitMeasurement } from "../pptx-translation-layout";

async function fixture() {
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  slide.addText("Source sentence", { x: 1, y: 1, w: 5, h: 1, fontSize: 20 });
  slide.addText("Unchanged", { x: 1, y: 3, w: 3, h: 1, fontSize: 14 });
  const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }) as Buffer);
  const manifest = await inspectOfficeTranslation(source);
  manifest.units.find((unit) => unit.text === "Source sentence")!.text = "Ein etwas längerer übersetzter Satz";
  return { source, manifest, translated: await applyOfficeTranslation(source, manifest) };
}
describe("PPT translation text fitting", () => {
  it.each(["new-overlap", "touching", "separate", "source-overlap", "different-slide"])("checks final neighboring glyphs: %s", (scenario) => {
    const boxes: TextFitBox[] = [
      { key: "a", slide: 1, text: "Formula", unitIds: ["a"], kind: "shape" },
      { key: "b", slide: scenario === "different-slide" ? 2 : 1, text: "Value", unitIds: ["b"], kind: "shape" },
    ];
    const rect = (left: number, right: number) => ({ left, right, top: 10, bottom: 30 });
    const measurement = (key: string, left: number, right: number): TextFitMeasurement => ({ key, scale: 1, fits: true,
      geometry: { frame: rect(0, 200), ink: rect(left, right) } });
    const before = [measurement("a", 0, scenario === "source-overlap" ? 140 : 80), measurement("b", 120, 200)];
    const after = [measurement("a", 0, scenario === "separate" ? 95 : scenario === "touching" ? 99.8 : 140), measurement("b", 100, 200)];
    const issues = findNewTextCollisions(boxes, before, after);
    expect(issues.map(item => item.key)).toEqual(["new-overlap", "touching"].includes(scenario) ? ["a", "b"] : []);
  });
  it("reserves the original text footprint but does not grant new space beyond it", async () => {
    const { source, manifest, translated } = await fixture();
    const frame = { left: 10, top: 10, right: 100, bottom: 30 };
    const ink = { left: 10, top: 6, right: 80, bottom: 32 };
    await fitPptxTranslation(source, translated, manifest, async (candidate, boxes) => {
      if (!candidate.equals(source)) expect(boxes[0].safeBounds).toEqual({ left: 10, top: 6, right: 100, bottom: 32 });
      return boxes.map(box => ({ key: box.key, scale: 1, fits: true, geometry: { frame, ink } }));
    });
  });
  it("identifies translated duplicates independently of preceding unchanged text", async () => {
    const pptx = new PptxGenJS(); const slide = pptx.addSlide();
    slide.addText("Same", { x: 1, y: 1, w: 2, h: 1 });
    slide.addText("Source", { x: 1, y: 3, w: 2, h: 1 });
    const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }) as Buffer);
    const manifest = await inspectOfficeTranslation(source);
    manifest.units.find(unit => unit.text === "Source")!.text = "Same";
    await fitPptxTranslation(source, await applyOfficeTranslation(source, manifest), manifest, async (candidate, boxes) => {
      expect(boxes[0].shapeId).toBeTruthy();
      expect(boxes[0].textOccurrence).toBe(candidate.equals(source) ? 0 : 1);
      return boxes.map(box => ({ key: box.key, scale: 1, fits: true }));
    });
  });
  it("adapts only a narrow CJK label's direction, retaining every character and geometry", async () => {
    const pptx = new PptxGenJS(); const slide = pptx.addSlide();
    slide.addText("全链路安全合规", { x: 1, y: 1, w: 0.25, h: 2, fontSize: 12, margin: 0 });
    const source = Buffer.from(await pptx.write({ outputType: "nodebuffer" }) as Buffer);
    const manifest = await inspectOfficeTranslation(source); manifest.units[0].text = "End-to-end security & compliance";
    const result = await fitPptxTranslation(source, await applyOfficeTranslation(source, manifest), manifest, async (_, boxes) =>
      boxes.map(box => ({ key: box.key, scale: 1, fits: true })));
    expect(result.rotatedLabels).toBe(1);
    await expect(verifyOfficeTranslationFidelity(source, result.output!, true)).resolves.toBeUndefined();
    await expect(verifyOfficeTranslationFidelity(source, result.output!)).rejects.toThrow();
    const zip = await JSZip.loadAsync(result.output!);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("text");
    expect(xml).toContain('vert="vert"');
    zip.file("ppt/slides/slide1.xml", xml.replace('vert="vert"', 'vert="vert270"'));
    await expect(verifyOfficeTranslationFidelity(source, await zip.generateAsync({ type: "nodebuffer" }), true)).rejects.toThrow();
  });
  it("writes native bounded autofit without moving shapes or changing original font properties", async () => {
    const { source, manifest, translated } = await fixture();
    const result = await fitPptxTranslation(source, translated, manifest, async (_, boxes, options) => {
      expect(boxes).toHaveLength(1);
      expect(boxes[0].unitIds).toEqual([manifest.units[0].id]);
      return boxes.map((box) => ({ key: box.key, scale: options?.allowShrink === false ? 1 : 0.8, fits: true }));
    });
    expect(result.adjustedShapes).toBe(1); expect(result.issues).toEqual([]);
    await expect(verifyOfficeTranslationFidelity(source, result.output!, true)).resolves.toBeUndefined();
    await expect(verifyOfficeTranslationFidelity(source, result.output!)).rejects.toThrow("原版式");
    const zip = await JSZip.loadAsync(result.output!);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("text");
    expect(xml).toContain('fontScale="80000"'); expect(xml).toContain('sz="2000"');
    zip.file("ppt/slides/slide1.xml", xml.replace('fontScale="80000"', 'fontScale="1000"'));
    await expect(verifyOfficeTranslationFidelity(source, await zip.generateAsync({ type: "nodebuffer" }), true)).rejects.toThrow();
  });
  it.each(["missing", "overflow", "tiny"])("does not publish %s text fitting results", async (failure) => {
    const { source, manifest, translated } = await fixture();
    const result = await fitPptxTranslation(source, translated, manifest, async (_, boxes) => failure === "missing" ? []
      : boxes.map((box) => ({ key: box.key, fits: failure !== "overflow", scale: failure === "tiny" ? 0.2 : 0.65, reason: "translation_too_long" })));
    expect(result.output).toBeUndefined(); expect(result.issues).toHaveLength(1);
    expect(result.issues[0].unitIds).toContain(manifest.units[0].id);
  });

  it("selects the largest verified native size and verifies the final serialized output", async () => {
    const { source, manifest, translated } = await fixture();
    const trials: number[] = [];
    const result = await fitPptxTranslation(source, translated, manifest, async (candidate, boxes, options) => {
      if (candidate.equals(source)) return [];
      if (options?.allowShrink !== false) return boxes.map(box => ({ key: box.key, scale: 0.55, fits: false, reason: "translation_too_long" }));
      const xml = await (await JSZip.loadAsync(candidate)).file("ppt/slides/slide1.xml")!.async("text");
      const scale = Number(xml.match(/fontScale="(\d+)"/)![1]) / 100000;
      trials.push(scale);
      return boxes.map(box => ({ key: box.key, scale: 1, fits: scale <= 0.8, minFontPt: 20 * scale, reason: "translation_too_long" }));
    });
    expect(trials).toEqual([1, 0.95, 0.9, 0.85, 0.8, 0.8]);
    expect(result.output).toBeInstanceOf(Buffer);
    expect(result.issues).toEqual([]);
  });

  it("rejects native fallback that only fits below a readable font size", async () => {
    const { source, manifest, translated } = await fixture();
    const result = await fitPptxTranslation(source, translated, manifest, async (candidate, boxes, options) => {
      if (candidate.equals(source)) return [];
      if (options?.allowShrink !== false) return boxes.map(box => ({ key: box.key, scale: 0.8, fits: false, reason: "translation_too_long" }));
      const xml = await (await JSZip.loadAsync(candidate)).file("ppt/slides/slide1.xml")!.async("text");
      const scale = Number(xml.match(/fontScale="(\d+)"/)![1]) / 100000;
      return boxes.map(box => ({ key: box.key, scale: 1, fits: scale <= 0.7, minFontPt: 10 * scale }));
    });
    expect(result.output).toBeUndefined();
  });

  it("does not publish a DOM-only fit when serialized text still overflows", async () => {
    const { source, manifest, translated } = await fixture();
    const result = await fitPptxTranslation(source, translated, manifest, async (_, boxes, options) =>
      boxes.map(box => ({ key: box.key, scale: options?.allowShrink === false ? 1 : 0.8,
        fits: options?.allowShrink !== false, reason: "translation_too_long" })));
    expect(result.output).toBeUndefined();
    expect(result.issues).toHaveLength(1);
  });

  it.each([false, true])("does not publish unresolved translated overflow even when the source is also tight: %s", async (worse) => {
    const { source, manifest, translated } = await fixture();
    let call = 0;
    const result = await fitPptxTranslation(source, translated, manifest, async (_, boxes) => {
      const baseline = call++ > 0;
      return boxes.map((box) => ({ key: box.key, fits: false, scale: 0.8,
        reason: "translation_too_long", overflow: { left: 0, right: 0, top: 2, bottom: 2,
          lines: !baseline && worse ? 20 : 10 } }));
    });
    expect(Boolean(result.output)).toBe(false);
  });
});
