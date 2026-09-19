import * as fs from "fs/promises";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

export interface DocxContentFinding {
  type: string;
  severity: "warning";
  path: string;
  message: string;
}

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const LIMIT = 20 * 1024 * 1024;

// These are review hints, not factual verification or automatic rewrite rules.
export function reviewDocxContentXml(xml: string): DocxContentFinding[] {
  if (xml.length > LIMIT) throw new Error("DOCX content review size limit exceeded");
  const document = new DOMParser({ errorHandler: {
    warning: () => {},
    error: () => { throw new Error("Invalid Word XML"); },
    fatalError: () => { throw new Error("Invalid Word XML"); },
  } }).parseFromString(xml, "application/xml");
  const elements = (node: Element | Document, name: string) =>
    Array.from(node.getElementsByTagNameNS(WORD_NS, name));
  const text = (node: Element) => elements(node, "t")
    .map((part) => part.textContent || "").join("").trim();
  const findings: DocxContentFinding[] = [];
  const captions = new Map<string, number>();
  for (const paragraph of elements(document, "p")) {
    const value = text(paragraph);
    if (/^(?:图\s*[：:]|Figure\s*:)/i.test(value)) {
      captions.set(value, (captions.get(value) || 0) + 1);
    }
  }
  for (const [caption, count] of captions) {
    if (count < 3) continue;
    findings.push({
      type: "repeated-figure-caption", severity: "warning", path: "word/document.xml",
      message: `${count} figures share the caption "${caption.slice(0, 160)}". Verify each image against its source page and give it a specific caption; embedded media count does not establish relevance.`,
    });
  }
  for (const [index, table] of elements(document, "tbl").entries()) {
    const rows = elements(table, "tr").filter((row) => row.parentNode === table);
    const cells = rows.map((row) => elements(row, "tc")
      .filter((cell) => cell.parentNode === row).map(text));
    const values = cells.slice(1).flat();
    const missing = values.filter((value) => /^(?:[—–-]|N\/A|待补充|待填写)?$/i.test(value)).length;
    if (values.length >= 12 && missing / values.length >= 1 / 3) {
      findings.push({
        type: "sparse-evidence-table", severity: "warning", path: `word/document.xml/table[${index + 1}]`,
        message: `${missing}/${values.length} body cells are blank or placeholders. Recheck the source table before calling the comparison complete. Keep genuinely unavailable values explicitly marked, never invent them.`,
      });
    }
    for (const [column, header] of (cells[0] || []).entries()) {
      if (!/\b[GT]FLOPS\b/i.test(header) || /比值|相对|ratio|relative/i.test(header)) continue;
      if (cells.slice(1).some((row) => /(?:^|约|≈|\s)\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?(?:$|\s)/.test(row[column] || ""))) {
        findings.push({
          type: "table-unit-mismatch", severity: "warning", path: `word/document.xml/table[${index + 1}]/column[${column + 1}]`,
          message: `Column "${header}" mixes an absolute compute unit with a ratio. Retrieve the source value or move the ratio to a separately labelled column.`,
        });
      }
    }
  }
  return findings;
}

export async function reviewDocxContent(filePath: string): Promise<DocxContentFinding[]> {
  const stat = await fs.stat(filePath);
  if (stat.size > 100 * 1024 * 1024) throw new Error("DOCX content review file size limit exceeded");
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const part = zip.file("word/document.xml");
  if (!part) throw new Error("Word document XML is missing");
  return reviewDocxContentXml((await readBoundedOfficePart(part)).toString("utf8"));
}

// Shared by the content and source-image checks; never inflate an unbounded ZIP part.
export async function readBoundedOfficePart(part: JSZip.JSZipObject, limit = LIMIT): Promise<Buffer> {
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = part.nodeStream("nodebuffer");
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        stream.pause();
        chunks.length = 0;
        reject(new Error("DOCX content review size limit exceeded"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.resume();
  });
  return buffer;
}
