import { createHash } from "crypto";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { translationTextIssue } from "./translation-text";

const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const serializer = new XMLSerializer();
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;

export type OfficeTranslationUnit = { id: string; text: string; context?: string };
export type OfficeTranslationManifest = {
  schema: "neoworker.office-translation.v1" | "neoworker.office-translation.v2" | "neoworker.office-translation.v3";
  sourceSha256: string;
  units: OfficeTranslationUnit[];
};

function parseXml(xml: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("不支持包含 DTD 或实体声明的 Office 文件。");
  return new DOMParser({ errorHandler: {
    warning: (message) => { throw new Error(message); },
    error: (message) => { throw new Error(message); },
    fatalError: (message) => { throw new Error(message); },
  } }).parseFromString(xml, "application/xml");
}

function isTextPart(name: string): boolean {
  return /^(?:ppt\/(?:slides|notesSlides|slideMasters|slideLayouts|notesMasters|charts|diagrams)\/|word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)|xl\/(?:sharedStrings|worksheets\/|drawings\/|comments\d*))/i.test(name)
    && name.endsWith(".xml");
}

export function officeTranslationTextElements(document: Document, includeEmpty = false): Element[] {
  return Array.from(document.getElementsByTagName("*")).filter((element) => {
    if (element.localName !== "t") return false;
    if (![DRAWING, WORD, SHEET].includes(element.namespaceURI || "")) return false;
    // Excel numeric/formula cells use <v>/<f>, which are never translation units.
    // Phonetic guides and calculated field results must not be translated alone.
    let parent = element.parentNode as Element | null;
    while (parent?.nodeType === 1) {
      if (["rPh", "fld", "fldSimple"].includes(parent.localName)) return false;
      if (parent.namespaceURI === WORD && parent.localName === "p"
        && parent.getElementsByTagNameNS(WORD, "fldChar").length > 0) return false;
      parent = parent.parentNode as Element | null;
    }
    return includeEmpty || Boolean(element.textContent?.trim());
  });
}
const textElements = officeTranslationTextElements;

async function openPackage(bytes: Buffer) {
  if (bytes.length > MAX_EXPANDED_BYTES) throw new Error("Office 文件过大，无法执行原版式翻译。");
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter((file) => !file.dir);
  if (files.length > 12000) throw new Error("Office 文件包含过多内部条目。");
  if (!zip.file("[Content_Types].xml")) throw new Error("源文件不是有效的 Office Open XML 文档。");
  if (!["ppt/presentation.xml", "word/document.xml", "xl/workbook.xml"].some((name) => zip.file(name))) {
    throw new Error("源文件缺少 Office 主文档。");
  }
  if (files.some((file) => file.name.startsWith("_xmlsignatures/"))) {
    throw new Error("源文档包含数字签名，翻译会使签名失效。请先提供未签名副本。");
  }
  let total = 0;
  const data = new Map<string, Buffer>();
  for (const file of files) {
    // JSZip exposes the expanded length before decompression; reject zip bombs.
    const expandedSize = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof expandedSize === "number" && expandedSize > MAX_EXPANDED_BYTES - total) {
      throw new Error("Office 文件解压后的大小超出限制。");
    }
    const content = await file.async("nodebuffer");
    total += content.length;
    if (total > MAX_EXPANDED_BYTES) throw new Error("Office 文件解压后的大小超出限制。");
    data.set(file.name, content);
  }
  return { zip, data };
}

function collectParts(data: Map<string, Buffer>, includeEmpty = false) {
  const parts = new Map<string, { document: Document; elements: Element[] }>();
  for (const [name, bytes] of data) {
    if (!isTextPart(name)) continue;
    const document = parseXml(bytes.toString("utf8"));
    parts.set(name, { document, elements: textElements(document, includeEmpty) });
  }
  return parts;
}

function paragraphOf(element: Element): Element | null {
  let parent = element.parentNode as Element | null;
  while (parent?.nodeType === 1 && !["p", "si", "is"].includes(parent.localName)) parent = parent.parentNode as Element | null;
  return parent?.nodeType === 1 ? parent : null;
}

function canJoin(left: Element, right: Element, acrossStyles = false): boolean {
  const a = left.parentNode as Element;
  const b = right.parentNode as Element;
  if (a.localName !== "r" || b.localName !== "r" || a === b || a.parentNode !== b.parentNode) return false;
  const children = (run: Element) => Array.from(run.childNodes).filter((node) => node.nodeType === 1) as Element[];
  // Do not merge across links, fields, drawings, tabs, breaks or style changes.
  if ([a, b].some((run) => children(run).some((node) => !["rPr", "t"].includes(node.localName)))) return false;
  if ([a, b].some((run) => children(run).filter((node) => node.localName === "t").length !== 1)) return false;
  let next = a.nextSibling;
  while (next && ((next.nodeType === 3 && !next.textContent?.trim())
    || (acrossStyles && next.nodeType === 1 && (next as Element).localName === "pPr"))) next = next.nextSibling;
  if (next !== b) return false;
  const style = (run: Element) => children(run).filter((node) => node.localName === "rPr").map((node) => serializer.serializeToString(node)).join("");
  return acrossStyles || style(a) === style(b);
}

function translationGroups(elements: Element[], grouped: boolean, paragraphMode = false): Array<{ index: number; elements: Element[] }> {
  const groups: Array<{ index: number; elements: Element[] }> = [];
  elements.forEach((element, index) => {
    const last = groups[groups.length - 1];
    if (grouped && last && canJoin(last.elements[last.elements.length - 1], element, paragraphMode)) last.elements.push(element);
    else groups.push({ index, elements: [element] });
  });
  return groups.filter((group) => group.elements.some((element) => element.textContent?.trim()));
}

function formatSegments(elements: Element[]): Element[][] {
  const segments: Element[][] = [];
  let previousStyle = "";
  for (const element of elements) {
    const properties = Array.from(element.parentNode!.childNodes)
      .find((node) => node.nodeType === 1 && (node as Element).localName === "rPr")?.cloneNode(true) as Element | undefined;
    // Language/proofing metadata is not a formatting boundary. Splitting here
    // translated AI, punctuation and Chinese fragments as independent sentences.
    for (const name of ["lang", "altLang", "dirty", "smtClean"]) properties?.removeAttribute(name);
    const style = properties ? serializer.serializeToString(properties) : "";
    if (segments.length && (style === previousStyle || !element.textContent?.trim())) segments[segments.length - 1].push(element);
    else { segments.push([element]); previousStyle = style; }
  }
  return segments;
}

function unitText(elements: Element[], paragraphMode: boolean): string {
  const segments = paragraphMode ? formatSegments(elements) : [elements];
  return segments.map((members, index) => {
    const text = members.map((element) => element.textContent || "").join("");
    return segments.length === 1 ? text : `⟦s${index}⟧${text}⟦/s${index}⟧`;
  }).join("");
}

/** Formatting anchors travel with one complete sentence/paragraph. Their text
 * can change, but removing/repeating/reordering anchors would corrupt styling. */
export function translationUnitIssue(source: OfficeTranslationUnit, text: unknown): string | null {
  const issue = translationTextIssue(text);
  if (issue) return issue;
  const markers = (value: string) => value.match(/⟦\/?s[^⟦⟧]*⟧/g) || [];
  const expected = markers(source.text);
  if (JSON.stringify(markers(text as string)) !== JSON.stringify(expected)) return "format_anchors_changed";
  if (expected.length) {
    const parts = Array.from((text as string).matchAll(/⟦s(\d+)⟧([\s\S]*?)⟦\/s\1⟧/g));
    if (parts.map((part) => part[0]).join("") !== text) return "text_outside_format_anchors";
    if (parts.some((part) => !part[2].trim() && source.text.split(`⟦s${part[1]}⟧`)[1].split(`⟦/s${part[1]}⟧`)[0].trim())) return "empty_formatted_segment";
  }
  return null;
}

export async function inspectOfficeTranslation(
  bytes: Buffer,
  mode: boolean | OfficeTranslationManifest["schema"] = "neoworker.office-translation.v3",
): Promise<OfficeTranslationManifest> {
  const schema = typeof mode === "boolean" ? (mode ? "neoworker.office-translation.v2" : "neoworker.office-translation.v1") : mode;
  if (!["neoworker.office-translation.v1", "neoworker.office-translation.v2", "neoworker.office-translation.v3"].includes(schema)) throw new Error("不支持的翻译清单版本。");
  const grouped = schema !== "neoworker.office-translation.v1";
  const paragraphMode = schema === "neoworker.office-translation.v3";
  const { data } = await openPackage(bytes);
  const units: OfficeTranslationUnit[] = [];
  for (const [name, part] of collectParts(data, paragraphMode)) {
    translationGroups(part.elements, grouped, paragraphMode).forEach(({ elements, index }) => {
      const paragraph = paragraphOf(elements[0]);
      units.push({ id: `${name}#${index}`, text: unitText(elements, paragraphMode), ...(paragraph ? { context: paragraph.textContent || "" } : {}) });
    });
  }
  if (!units.length) throw new Error("源文档没有可编辑文字，可能为扫描件或图片。不能用新模板替代原文件。");
  return { schema, sourceSha256: createHash("sha256").update(bytes).digest("hex"), units };
}

export async function applyOfficeTranslation(bytes: Buffer, manifest: OfficeTranslationManifest): Promise<Buffer> {
  if (!["neoworker.office-translation.v1", "neoworker.office-translation.v2", "neoworker.office-translation.v3"].includes(manifest?.schema)) throw new Error("不支持的翻译清单版本。");
  const grouped = manifest.schema !== "neoworker.office-translation.v1";
  const paragraphMode = manifest.schema === "neoworker.office-translation.v3";
  const expected = await inspectOfficeTranslation(bytes, manifest.schema);
  if (manifest?.schema !== expected.schema || manifest.sourceSha256 !== expected.sourceSha256) {
    throw new Error("翻译清单与源文件不匹配或原文件已发生变化，请重新读取源文件。");
  }
  if (!Array.isArray(manifest.units) || manifest.units.length !== expected.units.length) {
    throw new Error("翻译清单不完整：必须保留全部文字单元及其 id，不需翻译的内容原样保留。");
  }
  const translations = new Map<string, string>();
  for (const unit of manifest.units) {
    if (!unit || typeof unit.id !== "string" || translationTextIssue(unit.text) || translations.has(unit.id)) {
      throw new Error(`翻译清单包含重复 id、空文字或无效字符：${String(unit?.id || "missing-id").slice(0,180)}。仅修复此单元后重试 apply；不要重新翻译已完成内容。旧版清单如需合并碎片，请重新 inspect 获取分组清单。`);
    }
    translations.set(unit.id, unit.text);
  }
  if (expected.units.some((unit) => !translations.has(unit.id))) throw new Error("翻译清单包含未知或缺失的文字单元。");
  for (const unit of expected.units) {
    const issue = translationUnitIssue(unit, translations.get(unit.id));
    if (issue) throw new Error(`翻译单元 ${unit.id}: ${issue}。请保留格式标记，仅修复此单元后重试。`);
  }
  if (expected.units.every((unit) => translations.get(unit.id) === unit.text)) throw new Error("翻译清单没有修改任何文字，不能作为已翻译文件交付。");
  const { zip, data } = await openPackage(bytes);
  for (const [name, { document, elements }] of collectParts(data, paragraphMode)) {
    let changed = false;
    translationGroups(elements, grouped, paragraphMode).forEach(({ elements: members, index }) => {
      const text = translations.get(`${name}#${index}`)!;
      if (text === unitText(members, paragraphMode)) return;
      const segments = paragraphMode ? formatSegments(members) : [members];
      segments.forEach((segment, segmentIndex) => {
        const translated = segments.length === 1 ? text : text.split(`⟦s${segmentIndex}⟧`)[1].split(`⟦/s${segmentIndex}⟧`)[0];
        segment.forEach((element, offset) => {
          element.textContent = offset === 0 ? translated : "";
          element.setAttribute("xml:space", "preserve");
        });
      });
      changed = true;
    });
    if (changed) {
      const entry = zip.file(name)!;
      // Preserve ZIP metadata so applying the same saved translation later is
      // byte-stable and a failed publication can reuse its existing output.
      zip.file(name, serializer.serializeToString(document), {
        date: entry.date,
        comment: entry.comment,
        unixPermissions: entry.unixPermissions,
        dosPermissions: entry.dosPermissions,
      });
    }
  }
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await verifyOfficeTranslationFidelity(bytes, output);
  return output;
}

/** Compare native package structure, not merely whether an output can open. */
export async function verifyOfficeTranslationFidelity(source: Buffer, output: Buffer, allowTextFit = false): Promise<void> {
  const original = await openPackage(source);
  const translated = await openPackage(output);
  if (original.data.size !== translated.data.size) throw new Error("翻译输出改变了原文件的内部结构。");
  for (const [name, bytes] of original.data) {
    const result = translated.data.get(name);
    if (!result) throw new Error(`翻译输出缺少原文件内容：${name}`);
    if (bytes.equals(result)) continue;
    if (!isTextPart(name)) throw new Error(`翻译不允许修改原图片、样式、公式或附件：${name}`);
    const before = parseXml(bytes.toString("utf8"));
    const after = parseXml(result.toString("utf8"));
    const left = textElements(before, true);
    const right = textElements(after, true);
    if (left.length !== right.length) throw new Error(`翻译改变了文字对象数量：${name}`);
    for (const element of [...left, ...right]) {
      element.textContent = "__TRANSLATABLE_TEXT__";
      element.removeAttribute("xml:space");
    }
    if (allowTextFit && /^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      const oldBodies = Array.from(before.getElementsByTagNameNS(DRAWING, "bodyPr"));
      const newBodies = Array.from(after.getElementsByTagNameNS(DRAWING, "bodyPr"));
      if (oldBodies.length !== newBodies.length) throw new Error(`翻译改变了文本框数量：${name}`);
      for (let index = 0; index < oldBodies.length; index++) {
        const old = oldBodies[index]; const next = newBodies[index];
        if (serializer.serializeToString(old) === serializer.serializeToString(next)) continue;
        const oldFit = old.getElementsByTagNameNS(DRAWING, "normAutofit")[0];
        const oldScale = oldFit?.hasAttribute("fontScale") ? Number(oldFit.getAttribute("fontScale")) : 100000;
        const fit = Array.from(next.childNodes).filter((node) => node.nodeType === 1
          && ["noAutofit", "spAutoFit", "normAutofit"].includes((node as Element).localName)) as Element[];
        if (fit.length !== 1 || fit[0].localName !== "normAutofit" || fit[0].namespaceURI !== DRAWING
          || !/^\d+$/.test(fit[0].getAttribute("fontScale") || "")
          || Number(fit[0].getAttribute("fontScale")) < Math.floor(oldScale * 0.5) || Number(fit[0].getAttribute("fontScale")) > oldScale
          || (fit[0].getAttribute("lnSpcReduction") || "0") !== (oldFit?.getAttribute("lnSpcReduction") || "0")
          || Array.from(fit[0].attributes).some((attr) => !["fontScale", "lnSpcReduction"].includes(attr.name))
          || fit[0].hasChildNodes()) throw new Error(`无效的文字适配设置：${name}`);
        // Only the native text-fit child may change. Font faces, sizes, colors,
        // insets, shape geometry and every other body property remain protected.
        for (const body of [old, next]) for (const node of Array.from(body.childNodes)) {
          if (node.nodeType === 1 && (node as Element).namespaceURI === DRAWING
            && ["noAutofit", "spAutoFit", "normAutofit"].includes((node as Element).localName)) body.removeChild(node);
        }
      }
    }
    if (serializer.serializeToString(before) !== serializer.serializeToString(after)) {
      throw new Error(`翻译改变了原版式或非文字数据：${name}`);
    }
  }
}
