import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const importPdf = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>;

/** Render the selected region directly; never enlarge a low-resolution page crop. */
export function pdfRegionRenderPlan(width: number, height: number, crop?: {
  x: number; y: number; width: number; height: number;
}, dpi = 300) {
  if (!Number.isFinite(dpi) || dpi < 72 || dpi > 600) throw new Error("dpi must be between 72 and 600.");
  const region = crop || { x: 0, y: 0, width: 1, height: 1 };
  const pointsWidth = width * region.width, pointsHeight = height * region.height;
  // A column figure is often enlarged to full text width in the translation.
  // Allocate pixels for that output width, not for the original small column.
  const requestedScale = Math.max(dpi / 72, crop ? 2400 / pointsWidth : 0);
  const scale = Math.min(requestedScale, 6000 / Math.max(pointsWidth, pointsHeight),
    Math.sqrt(24_000_000 / (pointsWidth * pointsHeight)));
  return { scale, width: Math.ceil(pointsWidth * scale), height: Math.ceil(pointsHeight * scale),
    left: width * region.x * scale, top: height * region.y * scale,
    renderDpi: scale * 72, resolutionLimited: scale < requestedScale };
}

/** Bundled renderer: never requires a user's Poppler/Python installation. */
export async function renderPdfPages(file: string, directory: string, options: {
  firstPage: number; lastPage: number;
  crop?: { x: number; y: number; width: number; height: number };
  dpi?: number;
  signal?: AbortSignal;
}) {
  if ((await fs.stat(file)).size > 100 * 1024 * 1024) throw new Error("PDF exceeds 100 MiB.");
  const crop = options.crop;
  if (crop && (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
    crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
    crop.x + crop.width > 1 || crop.y + crop.height > 1)) {
    throw new Error("crop uses fractions of the full page: x/y >= 0, width/height > 0, and x+width/y+height <= 1.");
  }
  const pdfjs = await importPdf(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
  const loading = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  const cancel = () => { void loading.destroy().catch(() => {}); };
  const timeout = setTimeout(cancel, 60_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    options.signal?.throwIfAborted();
    const doc = await loading.promise;
    if (!Number.isInteger(options.firstPage) || options.firstPage < 1 || options.firstPage > doc.numPages ||
      !Number.isInteger(options.lastPage) || options.lastPage < options.firstPage || options.lastPage - options.firstPage >= 5) {
      throw new Error(`Choose 1–5 pages within this ${doc.numPages}-page PDF.`);
    }
    const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
    await fs.mkdir(directory, { recursive: true });
    const pages = [];
    for (let n = options.firstPage; n <= Math.min(doc.numPages, options.lastPage); n++) {
      options.signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const plan = pdfRegionRenderPlan(base.width, base.height, crop, options.dpi);
      const viewport = page.getViewport({ scale: plan.scale });
      const output = createCanvas(plan.width, plan.height);
      await page.render({ canvas: output as Any, canvasContext: output.getContext("2d") as Any, viewport,
        transform: [1, 0, 0, 1, -plan.left, -plan.top] }).promise;
      const imagePath = path.join(directory, `page-${n}.png`);
      await fs.writeFile(imagePath, output.toBuffer("image/png"));
      const content = await page.getTextContent();
      const text = content.items.flatMap((item) => {
        if (!("str" in item) || !item.str.trim()) return [];
        const transform = pdfjs.Util.transform(base.transform, item.transform);
        return [{ text: item.str, x: transform[4] / base.width, y: transform[5] / base.height,
          width: item.width / base.width, height: item.height / base.height }];
      });
      const visibleText = crop ? text.filter((item) => item.x + item.width > crop.x && item.x < crop.x + crop.width &&
        item.y > crop.y && item.y - item.height < crop.y + crop.height) : text;
      const clippedText = crop ? visibleText.filter((item) => item.x < crop.x - 0.002 ||
        item.x + item.width > crop.x + crop.width + 0.002 || item.y - item.height < crop.y - 0.002 ||
        item.y > crop.y + crop.height + 0.002).map((item) => item.text).slice(0, 12) : [];
      pages.push({ page: n, imagePath, width: output.width, height: output.height, text: visibleText,
        renderDpi: Math.round(plan.renderDpi), printWidthAt300Dpi: Number((output.width / 300).toFixed(2)),
        ...(plan.resolutionLimited ? { resolutionWarning: "Raster size limit reached. Keep this figure within printWidthAt300Dpi inches or preserve the source vector region; do not upscale the PNG." } : {}),
        ...(clippedText.length ? { cropWarning: "The crop cuts source text at its edges. Inspect for clipped labels or adjacent body columns and adjust the region before embedding.", clippedText } : {}) });
      page.cleanup();
    }
    return { totalPages: doc.numPages, pages };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    await loading.destroy();
  }
}
