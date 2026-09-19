import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { reviewDocxContent, reviewDocxContentXml } from "../docx-content-review";
import { runOfficeDocumentQualityCheck } from "../office-document-quality";

const dirs: string[] = [];
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const document = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const table = (rows: string[][]) => `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
const badReport = document(
  paragraph("图：发布会相关图示").repeat(5) + table([
    ["模型", "激活参数量", "每token推理算力GFlops", "HumanEval"],
    ["Model A", "70B", "140", "81.7"],
    ["Model B", "—", "—", "—"],
    ["Model C", "—", "约1/18", "—"],
  ]),
);

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("DOCX content review", () => {
  it("flags repeated captions, incomplete evidence tables and mixed units", () => {
    expect(reviewDocxContentXml(badReport).map((finding) => finding.type)).toEqual([
      "repeated-figure-caption", "sparse-evidence-table", "table-unit-mismatch",
    ]);
  });

  it("does not flag distinct captions, complete tables or explicitly relative columns", () => {
    expect(reviewDocxContentXml(document(
      paragraph("图1：模型结构，来源第5页") + paragraph("图2：数学示例，来源第11页") +
      table([["模型", "相对算力比值（参考GFLOPS）"], ["Model A", "1/18"]]),
    ))).toEqual([]);
  });

  it("does not treat repeated body text as a figure caption", () => {
    expect(reviewDocxContentXml(document(paragraph("来源：发布会").repeat(5)))).toEqual([]);
  });

  it("supports different XML namespace prefixes", () => {
    expect(reviewDocxContentXml(badReport.replaceAll("w:", "word:").replace("xmlns:w", "xmlns:word"))).toHaveLength(3);
  });

  it("rejects malformed XML rather than returning a clean review", () => {
    expect(() => reviewDocxContentXml("<w:document><")).toThrow();
  });

  it("preserves content warnings when OfficeCLI cannot run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docx-review-"));
    dirs.push(dir);
    const file = path.join(dir, "report.docx");
    const zip = new JSZip().file("word/document.xml", badReport);
    await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    expect(await reviewDocxContent(file)).toHaveLength(3);
    const report = await runOfficeDocumentQualityCheck(file, {
      runner: async () => { throw new Error("OfficeCLI unavailable"); },
    });
    expect(report.status).toBe("skipped");
    expect(report.contentReview?.status).toBe("issues");
    expect(report.contentReview?.findings).toHaveLength(3);
    expect(report.modelGuidance).toContain("not a factual or image-relevance check");
  });

  it("reports missing documents as unreviewed, not passed", async () => {
    const report = await runOfficeDocumentQualityCheck("/missing/report.docx", {
      runner: async () => { throw new Error("unavailable"); },
    });
    expect(report.contentReview?.status).toBe("unavailable");
  });

  it("keeps content findings separate from successful structure and rendering", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docx-review-"));
    dirs.push(dir);
    const file = path.join(dir, "report.docx");
    await fs.writeFile(file, await new JSZip().file("word/document.xml", badReport).generateAsync({ type: "nodebuffer" }));
    const report = await runOfficeDocumentQualityCheck(file, {
      runner: async (_executable, args) => ({
        stdout: args[0] === "--version" ? "test" : JSON.stringify({ success: true, data: { issues: [], count: 0 } }), stderr: "",
      }),
    });
    expect(report.status).toBe("passed");
    expect(report.visual?.passed).toBe(true);
    expect(report.contentReview?.status).toBe("issues");
    expect(report.contentReview?.findings).toHaveLength(3);
  });
});
