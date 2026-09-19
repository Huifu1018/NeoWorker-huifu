import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { readBoundedOfficePart, type DocxContentFinding } from "./docx-content-review";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const INCH = 914400;
const descendants = (node: Element | Document, ns: string, tag: string) => Array.from(node.getElementsByTagNameNS(ns, tag));
const child = (node: Element | undefined, ns: string, tag: string) => node && descendants(node, ns, tag).find((element) => element.parentNode === node);
const parse = (buffer: Buffer) => new DOMParser({ errorHandler: {
  warning: () => {},
  error: () => { throw new Error("Invalid Office source XML"); },
  fatalError: () => { throw new Error("Invalid Office source XML"); },
} }).parseFromString(buffer.toString("utf8"), "application/xml");
const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

async function loadPackage(file: string): Promise<JSZip> {
  if ((await fs.stat(file)).size > 50 * 1024 * 1024) throw new Error("Source figure review package limit exceeded");
  return JSZip.loadAsync(await fs.readFile(file));
}
type PartReader = (part: JSZip.JSZipObject, limit: number) => Promise<Buffer>;
async function relationships(zip: JSZip, part: string, read: PartReader): Promise<Map<string, string>> {
  const rel = zip.file(path.posix.join(path.posix.dirname(part), "_rels", path.posix.basename(part) + ".rels"));
  if (!rel) return new Map();
  return new Map(descendants(parse(await read(rel, 1024 * 1024)), "*", "Relationship")
    .filter((item) => item.getAttribute("TargetMode") !== "External")
    .map((item) => {
      const target = item.getAttribute("Target") || "";
      return [item.getAttribute("Id") || "", path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join(path.posix.dirname(part), target))];
    }));
}

/** Byte-identical tiny PPT components enlarged into report figures merit review, not automatic deletion. */
export async function reviewDocxSourceFigures(docxPath: string, sourcePaths: string[]): Promise<DocxContentFinding[]> {
  if (!sourcePaths.length) return [];
  let remainingBytes = 24 * 1024 * 1024;
  const read: PartReader = async (part, limit) => {
    if (remainingBytes <= 0) throw new Error("Source figure review total size limit exceeded");
    const buffer = await readBoundedOfficePart(part, Math.min(limit, remainingBytes));
    remainingBytes -= buffer.length;
    return buffer;
  };
  const output = await loadPackage(docxPath);
  const body = output.file("word/document.xml");
  if (!body) throw new Error("Missing Word content");
  const xml = parse(await read(body, 20 * 1024 * 1024));
  const rels = await relationships(output, "word/document.xml", read);
  const largeFigures = new Map<string, number>();
  const mediaHashes = new Map<string, string>();
  for (const drawing of [...descendants(xml, WP, "inline"), ...descendants(xml, WP, "anchor")]) {
    const extent = child(drawing, WP, "extent");
    const size = Math.max(Number(extent?.getAttribute("cx")), Number(extent?.getAttribute("cy")));
    if (!(size >= 2 * INCH)) continue;
    const target = rels.get(descendants(drawing, A, "blip")[0]?.getAttributeNS(R, "embed") || "");
    if (!target || !/^word\/media\//.test(target)) continue;
    const part = output.file(target);
    if (!part) continue;
    if (!mediaHashes.has(target)) {
      if (mediaHashes.size >= 32) throw new Error("Source figure review image limit exceeded");
      mediaHashes.set(target, hash(await read(part, 4 * 1024 * 1024)));
    }
    const identity = mediaHashes.get(target)!;
    largeFigures.set(identity, Math.max(size, largeFigures.get(identity) || 0));
  }
  if (!largeFigures.size) return [];
  const findings: DocxContentFinding[] = [];
  for (const source of sourcePaths.slice(0, 3)) {
    const zip = await loadPackage(source);
    const candidates = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    if (candidates.length > 100) throw new Error("Source figure review slide limit exceeded");
    const usages = new Map<string, { maxSize: number; parts: Set<string> }>();
    for (const slide of candidates) {
      const document = parse(await read(zip.file(slide)!, 2 * 1024 * 1024));
      const links = await relationships(zip, slide, read);
      for (const picture of descendants(document, P, "pic")) {
        const target = links.get(descendants(picture, A, "blip")[0]?.getAttributeNS(R, "embed") || "");
        if (!target || !/^ppt\/media\//.test(target)) continue;
        const extent = child(child(child(picture, P, "spPr"), A, "xfrm"), A, "ext");
        let width = Number(extent?.getAttribute("cx"));
        let height = Number(extent?.getAttribute("cy"));
        // Respect nested group scaling; local EMU dimensions alone are not slide dimensions.
        for (let parent = picture.parentNode; parent; parent = parent.parentNode) {
          if (parent.nodeType !== 1) continue;
          const group = parent as Element;
          if (group.namespaceURI !== P || group.localName !== "grpSp") continue;
          const transform = child(child(group, P, "grpSpPr"), A, "xfrm");
          const outer = child(transform, A, "ext");
          const inner = child(transform, A, "chExt");
          width *= Number(outer?.getAttribute("cx")) / Number(inner?.getAttribute("cx"));
          height *= Number(outer?.getAttribute("cy")) / Number(inner?.getAttribute("cy"));
        }
        const size = Math.max(width, height);
        const usage = usages.get(target) || { maxSize: 0, parts: new Set<string>() };
        usage.maxSize = Math.max(usage.maxSize, Number.isFinite(size) && size > 0 ? size : Infinity);
        usage.parts.add(path.posix.basename(slide));
        usages.set(target, usage);
      }
    }
    let inspected = 0;
    for (const [target, usage] of usages) {
      if (usage.maxSize > 0.5 * INCH) continue;
      if (++inspected > 32) throw new Error("Source figure review image limit exceeded");
      const part = zip.file(target);
      if (!part) continue;
      const outputSize = largeFigures.get(hash(await read(part, 4 * 1024 * 1024)));
      if (!outputSize || outputSize / usage.maxSize < 8) continue;
      findings.push({
        type: "enlarged-source-component", severity: "warning", path: "word/document.xml",
        message: `A report figure is byte-identical to ${path.basename(source)} / ${target}, used only as a ${(usage.maxSize / INCH).toFixed(2)} inch component in ${[...usage.parts].join(", ")}, but enlarged to ${(outputSize / INCH).toFixed(2)} inches in Word. Inspect the image and complete source diagram before treating it as a standalone figure. Do not remove legitimate logos or intentional detail enlargements automatically.`,
      });
    }
  }
  return findings;
}
