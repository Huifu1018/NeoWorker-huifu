import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isSuspiciousPdfText } from "./pdf-text";

export interface PdfLayoutIssue {
  page: number;
  type: "text-outside-page" | "unreadable-text" | "review-incomplete" | "low-resolution-image";
  message: string;
}

export interface PdfLayoutReview {
  passed: boolean;
  pageCount: number;
  checkedPages: number;
  text: string;
  issues: PdfLayoutIssue[];
  pagePaths: string[];
}

// Keep the native ESM import in the CommonJS Electron build as well.
const importModule = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>;

/** Inspect final PDF bytes, not the HTML that was sent to the printer. */
export async function reviewPdfLayout(
  filePath: string,
  options: { signal?: AbortSignal; renderDirectory?: string; minimumImageDpi?: number } = {},
): Promise<PdfLayoutReview> {
  const stat = await fs.stat(filePath);
  if (stat.size > 100 * 1024 * 1024) throw new Error("PDF exceeds the 100 MiB layout review limit.");
  options.signal?.throwIfAborted();
  const entry = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await importModule(pathToFileURL(entry).href);
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(filePath)),
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  let timedOut = false;
  const cancel = () => { void loading.destroy().catch(() => {}); };
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, 30_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const document = await loading.promise;
    const result: PdfLayoutReview = {
      passed: false, pageCount: document.numPages, checkedPages: 0,
      text: "", issues: [], pagePaths: [],
    };
    if (document.numPages > 200) {
      result.issues.push({ page: 0, type: "review-incomplete", message: "PDF exceeds the 200-page layout review limit." });
      return result;
    }
    if (options.renderDirectory) await fs.mkdir(options.renderDirectory, { recursive: true });
    for (let number = 1; number <= document.numPages; number++) {
      options.signal?.throwIfAborted();
      if (timedOut) throw new Error("PDF layout review timed out.");
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      if (options.minimumImageDpi) {
        const operators = await page.getOperatorList();
        let matrix = [...viewport.transform];
        const stack: number[][] = [];
        for (let i = 0; i < operators.fnArray.length; i++) {
          const op = operators.fnArray[i], args = operators.argsArray[i];
          if (op === pdfjs.OPS.save || op === pdfjs.OPS.paintFormXObjectBegin) {
            stack.push([...matrix]);
            if (op === pdfjs.OPS.paintFormXObjectBegin && args[0]) matrix = pdfjs.Util.transform(matrix, args[0]);
          } else if (op === pdfjs.OPS.restore || op === pdfjs.OPS.paintFormXObjectEnd) {
            matrix = stack.pop() || [...viewport.transform];
          } else if (op === pdfjs.OPS.transform) matrix = pdfjs.Util.transform(matrix, args);
          else if (op === pdfjs.OPS.paintImageXObject || op === pdfjs.OPS.paintInlineImageXObject) {
            const width = op === pdfjs.OPS.paintImageXObject ? args[1] : args[0].width;
            const height = op === pdfjs.OPS.paintImageXObject ? args[2] : args[0].height;
            const pointsWidth = Math.hypot(matrix[0], matrix[1]), pointsHeight = Math.hypot(matrix[2], matrix[3]);
            const dpi = Math.min(width * 72 / pointsWidth, height * 72 / pointsHeight);
            // Exempt small icons; inspect the actual printed transform, not HTML preview sizing.
            if (Math.max(pointsWidth, pointsHeight) >= 144 && dpi < options.minimumImageDpi) result.issues.push({
              page: number, type: "low-resolution-image",
              message: `Page ${number}: an embedded image (${width}×${height}px) has only ${Math.round(dpi)} effective DPI at its printed size (minimum ${options.minimumImageDpi}). Re-render the original PDF figure region with read_pdf_visual crop and dpi=600, targeting 300 effective DPI, or embed original vector artwork. Do not upscale a small screenshot; if the original is low resolution, report that limitation.`,
            });
          }
        }
      }
      const content = await page.getTextContent();
      const text: string[] = [];
      let overflow = 0;
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        text.push(item.str);
        const transform = pdfjs.Util.transform(viewport.transform, item.transform);
        const style = content.styles[item.fontName];
        const height = Math.hypot(transform[2], transform[3]);
        let angle = Math.atan2(transform[1], transform[0]);
        if (style?.vertical) angle += Math.PI / 2;
        const advance = style?.vertical ? item.height : item.width;
        const ascent = Number.isFinite(style?.ascent) ? style.ascent : 0.8;
        const descent = Number.isFinite(style?.descent) ? style.descent : -0.2;
        const corners = [0, advance].flatMap((along) => [descent * height, ascent * height].map((up) => ({
          x: transform[4] + along * Math.cos(angle) + up * Math.sin(angle),
          y: transform[5] + along * Math.sin(angle) - up * Math.cos(angle),
        })));
        // Small font metric/rounding discrepancies are harmless. Whole lines at
        // the right margin (the reported fpdf cursor bug) are not.
        if (corners.some(({ x, y }) => !Number.isFinite(x + y) || x < -2 || y < -2 || x > viewport.width + 2 || y > viewport.height + 2)) overflow++;
      }
      const pageText = text.join(" ");
      result.text += `${pageText}\n`;
      if (overflow) result.issues.push({
        page: number, type: "text-outside-page",
        message: `Page ${number}: ${overflow} text runs extend outside the page; correct text positions and wrapping.`,
      });
      if (pageText && isSuspiciousPdfText(pageText)) result.issues.push({
        page: number, type: "unreadable-text", message: `Page ${number}: extracted text contains unreadable characters.`,
      });
      if (options.renderDirectory) {
        // pdfjs already uses this N-API canvas in Node. This fallback makes final
        // page evidence independent of an externally installed Poppler binary.
        const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
        const scale = Math.min(1.5, 1600 / Math.max(viewport.width, viewport.height));
        const rasterViewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(rasterViewport.width), Math.ceil(rasterViewport.height));
        await page.render({ canvas: canvas as Any, canvasContext: canvas.getContext("2d") as Any, viewport: rasterViewport }).promise;
        const pagePath = path.join(options.renderDirectory, `final-page-${String(number).padStart(3, "0")}.png`);
        await fs.writeFile(pagePath, canvas.toBuffer("image/png"));
        result.pagePaths.push(pagePath);
      }
      result.checkedPages++;
      page.cleanup();
    }
    options.signal?.throwIfAborted();
    if (timedOut) throw new Error("PDF layout review timed out.");
    result.passed = result.issues.length === 0 && result.checkedPages === result.pageCount;
    return result;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    await loading.destroy();
  }
}
