import { nativeImage } from "electron";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderPdfPages } from "../utils/pdf-page-render";

export async function resizeNewsCover(bytes: Buffer): Promise<Buffer | null> {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  // Reject badges/tracking pixels and unreasonable image dimensions.
  if (width < 160 || height < 90 || width * height > 24_000_000) return null;
  const scale = Math.min(1, 960 / width, 960 / height);
  return image
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: "good",
    })
    .toJPEG(80);
}
export async function renderNewsPdfCover(
  bytes: Buffer,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-news-cover-"));
  try {
    const file = path.join(dir, "paper.pdf");
    await fs.writeFile(file, bytes);
    const rendered = await renderPdfPages(file, dir, {
      firstPage: 1,
      lastPage: 1,
      dpi: 144,
      signal,
    });
    return await fs.readFile(rendered.pages[0].imagePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
