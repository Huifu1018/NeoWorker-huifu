import { createHash } from "crypto";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const serializer = new XMLSerializer();
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;

export type OfficeTranslationUnit = { id: string; text: string; context?: string };
export type OfficeTranslationManifest = {
  schema: "neoworker.office-translation.v1";
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

function textElements(document: Document): Element[] {
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
    return Boolean(element.textContent?.trim());
  });
}

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

function collectParts(data: Map<string, Buffer>) {
  const parts = new Map<string, { document: Document; elements: Element[] }>();
  for (const [name, bytes] of data) {
    if (!isTextPart(name)) continue;
    const document = parseXml(bytes.toString("utf8"));
    parts.set(name, { document, elements: textElements(document) });
  }
  return parts;
}

export async function inspectOfficeTranslation(bytes: Buffer): Promise<OfficeTranslationManifest> {
  const { data } = await openPackage(bytes);
  const units: OfficeTranslationUnit[] = [];
  for (const [name, part] of collectParts(data)) {
    part.elements.forEach((element, index) => {
      let paragraph = element.parentNode as Element | null;
      while (paragraph?.nodeType === 1 && !["p", "si", "is"].includes(paragraph.localName)) paragraph = paragraph.parentNode as Element | null;
      units.push({ id: `${name}#${index}`, text: element.textContent || "", ...(paragraph?.nodeType === 1 ? { context: paragraph.textContent || "" } : {}) });
    });
  }
  if (!units.length) throw new Error("源文档没有可编辑文字，可能为扫描件或图片。不能用新模板替代原文件。");
  return { schema: "neoworker.office-translation.v1", sourceSha256: createHash("sha256").update(bytes).digest("hex"), units };
}

export async function applyOfficeTranslation(bytes: Buffer, manifest: OfficeTranslationManifest): Promise<Buffer> {
  const expected = await inspectOfficeTranslation(bytes);
  if (manifest?.schema !== expected.schema || manifest.sourceSha256 !== expected.sourceSha256) {
    throw new Error("翻译清单与源文件不匹配或原文件已发生变化，请重新读取源文件。");
  }
  if (!Array.isArray(manifest.units) || manifest.units.length !== expected.units.length) {
    throw new Error("翻译清单不完整：必须保留全部文字单元及其 id，不需翻译的内容原样保留。");
  }
  const translations = new Map<string, string>();
  for (const unit of manifest.units) {
    if (!unit || typeof unit.id !== "string" || typeof unit.text !== "string" || !unit.text.trim()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(unit.text) || translations.has(unit.id)) {
      throw new Error("翻译清单包含重复 id、空文字或无效字符。");
    }
    translations.set(unit.id, unit.text);
  }
  if (expected.units.some((unit) => !translations.has(unit.id))) throw new Error("翻译清单包含未知或缺失的文字单元。");
  if (expected.units.every((unit) => translations.get(unit.id) === unit.text)) throw new Error("翻译清单没有修改任何文字，不能作为已翻译文件交付。");
  const { zip, data } = await openPackage(bytes);
  for (const [name, { document, elements }] of collectParts(data)) {
    let changed = false;
    elements.forEach((element, index) => {
      const text = translations.get(`${name}#${index}`)!;
      if (text === element.textContent) return;
      element.textContent = text;
      changed = true;
    });
    if (changed) zip.file(name, serializer.serializeToString(document));
  }
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await verifyOfficeTranslationFidelity(bytes, output);
  return output;
}

/** Compare native package structure, not merely whether an output can open. */
export async function verifyOfficeTranslationFidelity(source: Buffer, output: Buffer): Promise<void> {
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
    const left = textElements(before);
    const right = textElements(after);
    if (left.length !== right.length) throw new Error(`翻译改变了文字对象数量：${name}`);
    for (const element of [...left, ...right]) element.textContent = "__TRANSLATABLE_TEXT__";
    if (serializer.serializeToString(before) !== serializer.serializeToString(after)) {
      throw new Error(`翻译改变了原版式或非文字数据：${name}`);
    }
  }
}
