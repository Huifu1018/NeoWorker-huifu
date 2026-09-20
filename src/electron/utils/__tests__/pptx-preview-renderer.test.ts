import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBundledOfficeCliRenderer } from "../PptxPreviewService";
import { renderOfficeHtmlVisualEvidence } from "../office-html-visual-renderer";
vi.mock("../officecli-runtime", () => ({ resolveBundledOfficeCliExecutable: () => "Office工具.exe" }));
vi.mock("../office-html-visual-renderer", () => ({ renderOfficeHtmlVisualEvidence: vi.fn() }));
let root: string;
afterEach(async () => { vi.clearAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); });

describe("bundled PPT attachment preview", () => {
  it("renders an equivalent temporary copy without changing the attachment", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ppt-preview-"));
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", '<a:test xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:prstClr val="white"><a:alpha val="50000"/></a:prstClr></a:test>');
    const source = await zip.generateAsync({ type: "nodebuffer" });
    const sourcePath = path.join(root, "原附件.pptx");
    await fs.writeFile(sourcePath, source);
    const outputDir = path.join(root, "preview"); await fs.mkdir(outputDir);
    const image = path.join(outputDir, "page.png"); await fs.writeFile(image, "rendered-image");
    vi.mocked(renderOfficeHtmlVisualEvidence).mockResolvedValue({ imagePaths: [image], pageCount: 1, evidencePath: root, renderer: "electron-chromium" });
    let called = false;
    await runBundledOfficeCliRenderer(async (_exe, args, options) => {
      called = true;
      expect(args[1]).not.toBe(sourcePath);
      const rendered = await JSZip.loadAsync(await fs.readFile(args[1]));
      expect(await rendered.file("ppt/slides/slide1.xml")!.async("text")).toContain('srgbClr val="FFFFFF"');
      expect(options.windowsHide).toBe(true);
    }, { sourcePath, outputDir, maxSlides: 80 }, { timeout: 45_000 });
    expect(called).toBe(true);
    expect(await fs.readFile(sourcePath)).toEqual(source);
    expect(await fs.readFile(path.join(outputDir, "slide-1.png"), "utf8")).toBe("rendered-image");
  });
  it("retains structured renderer diagnostics", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ppt-preview-"));
    await expect(runBundledOfficeCliRenderer(async () => { throw { code: 1, stdout: '{"error":{"error":"render diagnostic"}}' }; },
      { sourcePath: "legacy.ppt", outputDir: root, maxSlides: 80 }, { timeout: 45_000 })).rejects.toThrow("render diagnostic");
  });
});
