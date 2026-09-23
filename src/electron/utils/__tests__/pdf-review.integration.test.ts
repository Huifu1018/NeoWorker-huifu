import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import PDFDocument from "pdfkit";
import { afterEach, describe, expect, it } from "vitest";

describe("real PDF review reader", () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

  it("reads each page natively instead of silently returning a truncated combined preview", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-review-pages-"));
    directories.push(dir);
    const filename = path.join(dir, "report.pdf");
    await new Promise<void>((resolve, reject) => {
      const document = new PDFDocument();
      const stream = fs.createWriteStream(filename);
      document.pipe(stream);
      for (let page = 1; page <= 3; page++) {
        if (page > 1) document.addPage();
        document.text(`Unique page ${page}: This report contains readable source text for a complete translation. Every paragraph must remain available to the reader.`);
      }
      document.text("Left column start", 72, 200);
      document.text("Left column end", 72, 230);
      document.text("Right column start", 330, 200);
      document.text("Right column end", 330, 230);
      document.end();
      stream.on("finish", resolve).on("error", reject);
    });
    // Run outside Vitest's VM and transpile as CommonJS, like the desktop build.
    // A source-only ESM test would miss the packaged app's import failures.
    const result = JSON.parse(execFileSync(process.execPath, ["-e", `
      const ts = require('typescript');
      const fs = require('node:fs');
      require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(
        fs.readFileSync(file, 'utf8'), { compilerOptions: {
          module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
        }}).outputText, file);
      require(process.argv[1]).extractPdfReviewData(process.argv[2], {
        includeOcr: false, maxPages: 3
      }).then(result => process.stdout.write(JSON.stringify(result)));
    `, path.resolve("src/electron/utils/pdf-review.ts"), filename], { encoding: "utf8", timeout: 15_000 }));
    expect(result.extractionMode).toBe("native");
    expect(result.pageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.truncatedPages).toBe(false);
    const lastPage = result.pages[2].text;
    expect(lastPage.indexOf("Left column end")).toBeLessThan(lastPage.indexOf("Right column start"));
    result.pages.forEach((page: { text: string; truncated: boolean }, index: number) => {
      expect(page.text).toContain(`Unique page ${index + 1}`);
      expect(page.truncated).toBe(false);
    });
  });
});
