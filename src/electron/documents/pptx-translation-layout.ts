import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { officeTranslationTextElements, verifyOfficeTranslationFidelity, type OfficeTranslationManifest } from "./office-translation";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const serializer = new XMLSerializer();
const parse = (text: string) => new DOMParser().parseFromString(text, "application/xml");
export type TextFitRect = { left: number; top: number; right: number; bottom: number };
export type TextFitBox = { key: string; slide: number; text: string; unitIds: string[]; kind: "shape" | "table"; safeBounds?: TextFitRect; shapeId?: string; textOccurrence?: number };
export type TextFitMeasurement = { key: string; scale: number; fits: boolean; reason?: string; minFontPt?: number; geometry?: { frame: TextFitRect; ink: TextFitRect };
  overflow?: { left: number; right: number; top: number; bottom: number; lines: number } };
export type TextFitIssue = TextFitBox & { reason: string };

/** Detect two translations expanding into the same formerly empty gap. */
export function findNewTextCollisions(boxes: TextFitBox[], before: TextFitMeasurement[], after: TextFitMeasurement[]): TextFitIssue[] {
  const original = new Map(before.map(item => [item.key, item.geometry?.ink]));
  const final = new Map(after.map(item => [item.key, item.geometry?.ink]));
  const issues = new Map<string, TextFitIssue>();
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.slide !== b.slide) continue;
    const oldA = original.get(a.key), oldB = original.get(b.key);
    const newA = final.get(a.key), newB = final.get(b.key);
    if (!oldA || !oldB || !newA || !newB) continue;
    const originallySeparate = oldA.right <= oldB.left - 2 || oldB.right <= oldA.left - 2
      || oldA.bottom <= oldB.top - 2 || oldB.bottom <= oldA.top - 2;
    if (!originallySeparate) continue;
    const oldGapX = Math.max(oldB.left - oldA.right, oldA.left - oldB.right);
    const oldGapY = Math.max(oldB.top - oldA.bottom, oldA.top - oldB.bottom);
    const newGapX = Math.max(newB.left - newA.right, newA.left - newB.right);
    const newGapY = Math.max(newB.top - newA.bottom, newA.top - newB.bottom);
    // Preserve a visible gutter as well as avoiding literal overlap. Font
    // strokes/shadows make a subpixel gap look like touching or merged text.
    const tooCloseX = oldGapX >= 2 && oldGapY < -2 && newGapY < -2 && newGapX < Math.min(2, oldGapX / 2);
    if (!tooCloseX && !(newGapX < -2 && newGapY < -2)) continue;
    for (const box of [a, b]) issues.set(box.key, { ...box, reason: "translated_neighbor_text_overlap" });
  }
  return [...issues.values()];
}

// A few localized labels are so much longer than their CJK source that the
// normal bounded autofit floor cannot fit them.  Give those boxes one final,
// deterministic native fallback before asking the model to rewrite content.
// This is still bounded (50% of the original size) and keeps every translated
// character in the document.
const EMERGENCY_FONT_SCALE = 0.5;

/** Apply measured native text fitting, retaining every shape, picture and run.
 * Dense translations that cannot fit legibly must be rewritten by the model. */
export async function fitPptxTranslation(
  source: Buffer,
  translated: Buffer,
  manifest: OfficeTranslationManifest,
  measure?: (candidate: Buffer, boxes: TextFitBox[], options?: { allowShrink?: boolean }) => Promise<TextFitMeasurement[]>,
) {
  await verifyOfficeTranslationFidelity(source, translated);
  const original = await JSZip.loadAsync(source);
  const zip = await JSZip.loadAsync(translated);
  const parts = new Map<string, Document>();
  const bodies = new Map<string, { fit: Element; baseScale: number }>();
  const boxes: TextFitBox[] = [];
  const sourceBoxes: TextFitBox[] = [];
  const knownIds = new Set(manifest.units.map((unit) => unit.id));
  const relationships = parse(await zip.file("ppt/_rels/presentation.xml.rels")!.async("text"));
  const targets = new Map(Array.from(relationships.getElementsByTagName("Relationship"))
    .map((rel) => [rel.getAttribute("Id"), rel.getAttribute("Target")!.replace(/^\/?ppt\//, "")]));
  const presentation = parse(await zip.file("ppt/presentation.xml")!.async("text"));
  const order = Array.from(presentation.getElementsByTagNameNS(P, "sldId"))
    .map((id) => `ppt/${targets.get(id.getAttributeNS(R, "id"))}`);
  for (const [slideIndex, name] of order.entries()) {
    const entry = zip.file(name);
    if (!entry) throw new Error(`Missing slide ${name}`);
    const before = parse(await original.file(name)!.async("text"));
    const document = parse(await entry.async("text"));
    const textBodies = (document: Document) => Array.from(document.getElementsByTagName("*"))
      .filter((element) => element.localName === "txBody" && [A, P].includes(element.namespaceURI || ""));
    const oldBodies = textBodies(before);
    const newBodies = textBodies(document);
    const elements = officeTranslationTextElements(before, manifest.schema === "neoworker.office-translation.v3");
    const text = (body: Element) => Array.from(body.getElementsByTagNameNS(A, "t")).map((item) => item.textContent || "").join("");
    const occurrence = (list: Element[], index: number) => list.slice(0, index).filter(body => body.namespaceURI === list[index].namespaceURI
      && text(body).replace(/\s|\u200b/g, "") === text(list[index]).replace(/\s|\u200b/g, "")).length;
    newBodies.forEach((body, index) => {
      if (!text(body).trim() || (body.namespaceURI !== A && text(oldBodies[index]) === text(body))) return;
      const unitIds = elements.flatMap((element, elementIndex) => {
        let ancestor: Node | null = element;
        while (ancestor && ancestor !== oldBodies[index]) ancestor = ancestor.parentNode;
        const id = `${name}#${elementIndex}`;
        return ancestor && knownIds.has(id) ? [id] : [];
      });
      const key = `${name}@${index}`;
      const properties = body.getElementsByTagNameNS(A, "bodyPr")[0];
      if (!properties) throw new Error(`Missing text body properties in ${name}`);
      const previous = properties.getElementsByTagNameNS(A, "normAutofit")[0];
      const baseScale = previous?.hasAttribute("fontScale") ? Number(previous.getAttribute("fontScale")) : 100000;
      const lineReduction = previous?.getAttribute("lnSpcReduction") || "0";
      for (const child of Array.from(properties.childNodes)) {
        if (child.nodeType === 1 && ["noAutofit", "spAutoFit", "normAutofit"].includes((child as Element).localName)) properties.removeChild(child);
      }
      const fit = document.createElementNS(A, "a:normAutofit");
      fit.setAttribute("fontScale", String(baseScale));
      fit.setAttribute("lnSpcReduction", lineReduction);
      const following = Array.from(properties.childNodes).find((child) => child.nodeType === 1
        && ["scene3d", "sp3d", "flatTx", "extLst"].includes((child as Element).localName));
      properties.insertBefore(fit, following || null);
      const parent = body.parentNode as Element;
      const shapeId = (parent.parentNode as Element | null)?.localName === "spTree"
        ? parent.getElementsByTagNameNS(P, "cNvPr")[0]?.getAttribute("id") || undefined : undefined;
      boxes.push({ key, slide: slideIndex + 1, text: text(body), unitIds, kind: body.namespaceURI === A ? "table" : "shape", shapeId, textOccurrence: occurrence(newBodies, index) });
      sourceBoxes.push({ ...boxes[boxes.length - 1], text: text(oldBodies[index]), textOccurrence: occurrence(oldBodies, index) });
      bodies.set(key, { fit, baseScale });
      parts.set(name, document);
    });
  }
  const generate = async () => {
    for (const [name, document] of parts) {
      const entry = zip.file(name)!;
      zip.file(name, serializer.serializeToString(document), {
        date: entry.date, comment: entry.comment, unixPermissions: entry.unixPermissions, dosPermissions: entry.dosPermissions,
      });
    }
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  };
  const candidate = await generate();
  const measureBoxes = measure || (await import("../utils/measure-pptx-text-fit")).measurePptxTextFit;
  // Text frames in real decks often overlap while their original glyphs do
  // not (for example a row label and its numeric value). Preserve the original
  // separation instead of treating each oversized frame as free space.
  const sourceMeasurements = boxes.length ? await measureBoxes(source, sourceBoxes, { allowShrink: false }) : [];
  const sourceGeometry = new Map(sourceMeasurements.map(result => [result.key, result.geometry]));
  for (const box of boxes) {
    const own = sourceGeometry.get(box.key);
    if (!own || box.kind !== "shape") continue;
    // Preserve the source's actual text footprint. Compact templates can
    // intentionally extend glyphs/leading outside the nominal text frame;
    // requiring them to fit a smaller area forces destructive rewrites even
    // for shorter translations. Page edges and neighboring text still bound it.
    const safe = { left: Math.min(own.frame.left, own.ink.left), top: Math.min(own.frame.top, own.ink.top),
      right: Math.max(own.frame.right, own.ink.right), bottom: Math.max(own.frame.bottom, own.ink.bottom) };
    for (const other of boxes) {
      if (other.key === box.key || other.slide !== box.slide) continue;
      const neighbor = sourceGeometry.get(other.key);
      if (!neighbor) continue;
      const a = own.ink, b = neighbor.ink;
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (overlapY > 2) {
        if (a.right <= b.left - 2) safe.right = Math.min(safe.right, b.left - Math.min(6, (b.left - a.right) / 2));
        if (a.left >= b.right + 2) safe.left = Math.max(safe.left, b.right + Math.min(6, (a.left - b.right) / 2));
      }
      if (overlapX > 2) {
        if (a.bottom <= b.top - 2) safe.bottom = Math.min(safe.bottom, b.top - Math.min(6, (b.top - a.bottom) / 2));
        if (a.top >= b.bottom + 2) safe.top = Math.max(safe.top, b.bottom + Math.min(6, (a.top - b.bottom) / 2));
      }
    }
    if (safe.left < safe.right && safe.top < safe.bottom) box.safeBounds = safe;
  }
  let measurements = boxes.length ? await measureBoxes(candidate, boxes) : [];
  const fontFloors = new Map(measurements.map(result => {
    const originalFont = typeof result.minFontPt === "number" ? result.minFontPt / result.scale : 10;
    // Preserve compact labels from the template: at most 20% smaller for
    // fonts below 10pt, never below 6pt. Ordinary body text retains an 8pt floor.
    return [result.key, Math.min(8, Math.max(6, originalFont * 0.8))];
  }));
  // Write the regular fit first. Native OOXML rendering may differ from a
  // temporary DOM font change, so verify the serialized candidate itself.
  for (const result of measurements) {
    if (result.fits && result.scale >= EMERGENCY_FONT_SCALE && result.scale <= 1) {
      const body = bodies.get(result.key)!;
      body.fit.setAttribute("fontScale", String(Math.floor(body.baseScale * result.scale)));
    }
  }
  const unresolved = new Set(measurements.filter(result => !result.fits).map(result => result.key));
  const nativeMinimumScales = new Map(measurements.map(result => [result.key,
    typeof result.minFontPt === "number" && result.minFontPt > 0
      ? Math.max(EMERGENCY_FONT_SCALE, fontFloors.get(result.key)! / (result.minFontPt / result.scale))
      : EMERGENCY_FONT_SCALE]));
  // Try the largest native size first instead of jumping directly to the
  // emergency floor. Every trial is measured without any further DOM shrink.
  for (const scale of [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5]) {
    const eligible = new Set([...unresolved].filter(key => scale >= nativeMinimumScales.get(key)! - 0.001));
    if (!eligible.size) break;
    for (const key of eligible) {
      const body = bodies.get(key)!;
      body.fit.setAttribute("fontScale", String(Math.floor(body.baseScale * scale)));
    }
    const nativeResults = await measureBoxes(await generate(), boxes, { allowShrink: false });
    const resolved = new Map<string, TextFitMeasurement>();
    for (const result of nativeResults) {
      if (!eligible.has(result.key) || !result.fits || result.scale !== 1) continue;
      if (scale < 1 && typeof result.minFontPt === "number" && result.minFontPt < fontFloors.get(result.key)! - 0.01) continue;
      resolved.set(result.key, { ...result, scale });
      unresolved.delete(result.key);
    }
    measurements = measurements.map(result => resolved.get(result.key) || result);
  }
  const results = new Map(measurements.map((result) => [result.key, result]));
  const issues: TextFitIssue[] = [];
  let adjustedShapes = 0;
  for (const box of boxes) {
    const result = results.get(box.key);
    if (!result || !result.fits || !Number.isFinite(result.scale) || (typeof result.minFontPt === "number" && result.scale < 1 && result.minFontPt < fontFloors.get(result.key)! - 0.01) || result.scale < EMERGENCY_FONT_SCALE || result.scale > 1) {
      issues.push({ ...box, reason: result?.reason || "text_fit_not_verified" }); continue;
    }
    const { fit, baseScale } = bodies.get(box.key)!;
    fit.setAttribute("fontScale", String(Math.floor(baseScale * result.scale)));
    if (result.scale < 1) adjustedShapes++;
  }
  if (issues.length) return { output: undefined, checkedShapes: boxes.length, adjustedShapes, issues };
  const output = await generate();
  const finalMeasurements = boxes.length ? await measureBoxes(output, boxes, { allowShrink: false }) : [];
  const finalMap = new Map(finalMeasurements.map(result => [result.key, result]));
  for (const box of boxes) {
    const result = finalMap.get(box.key);
    if (!result?.fits || result.scale !== 1) issues.push({ ...box, reason: result?.reason || "serialized_text_fit_not_verified" });
  }
  issues.push(...findNewTextCollisions(boxes, sourceMeasurements, finalMeasurements));
  if (issues.length) return { output: undefined, checkedShapes: boxes.length, adjustedShapes, issues };
  await verifyOfficeTranslationFidelity(source, output, true);
  const adjustedKeys = new Set(measurements.filter(result => result.scale < 1).map(result => result.key));
  const adjustedFonts = finalMeasurements.filter(result => adjustedKeys.has(result.key)
    && typeof result.minFontPt === "number").map(result => result.minFontPt!);
  return { output, checkedShapes: boxes.length, adjustedShapes, issues,
    minimumScale: Math.min(1, ...measurements.map(result => result.scale)),
    minimumAdjustedFontPt: adjustedFonts.length ? Math.min(...adjustedFonts) : undefined };
}
