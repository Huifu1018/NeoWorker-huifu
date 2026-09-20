import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractPptxStructuredContentFromFile } from "../pptx-extractor";
import { PptxPreviewService } from "../PptxPreviewService";

const PNG_BYTES = Buffer.from("presentation-preview");

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "neoworker-pptx-preview-test-"),
  );
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function createDeck(filePath: string): Promise<void> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const first = pptx.addSlide();
  first.addText("Intro", { x: 0.6, y: 0.7, w: 6, h: 0.5, fontSize: 28 });
  first.addText("Opening slide", {
    x: 0.6,
    y: 1.4,
    w: 6,
    h: 0.5,
    fontSize: 18,
  });
  first.addNotes("Presenter note A");

  const second = pptx.addSlide();
  second.addText("Findings", { x: 0.6, y: 0.7, w: 6, h: 0.5, fontSize: 28 });
  second.addText("First point\nSecond point", {
    x: 0.6,
    y: 1.4,
    w: 6,
    h: 1.5,
    fontSize: 18,
  });
  second.addNotes("Presenter note B");

  await pptx.writeFile({ fileName: filePath });
}

describe("PptxPreviewService", () => {
  it("omits model-only image diagnostics from preview text while preserving model extraction", async () => {
    const deckPath = path.join(tempRoot, "image.pptx");
    await createDeck(deckPath);
    const zip = await JSZip.loadAsync(await fs.readFile(deckPath));
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    zip.file("ppt/slides/slide1.xml", xml.replace("</p:spTree>", '<p:pic><p:nvPicPr><p:cNvPr id="90" name="Internal image"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId90"/></p:blipFill></p:pic></p:spTree>'));
    await fs.writeFile(deckPath, await zip.generateAsync({ type: "nodebuffer" }));
    expect((await extractPptxStructuredContentFromFile(deckPath)).slides[0].text).toContain("Image asset:");
    const preview = await new PptxPreviewService({ cacheRoot: path.join(tempRoot, "cache") }).buildPreview({ filePath: deckPath, renderMode: "fast" });
    expect(preview.slides[0].text).toContain("Opening slide");
    expect(preview.slides[0].text).not.toContain("Image asset:");
    expect(preview.slides[0].text).not.toContain("Internal image");
  });
  it("preserves local text warnings with rendered images and across cache reloads", async () => {
    const deckPath = path.join(tempRoot, "warning.pptx");
    await createDeck(deckPath);
    const options = {
      cacheRoot: path.join(tempRoot, "cache"),
      commandRunner: async () => { throw new Error("No external renderer"); },
      artifactToolRunner: null,
      officeCliRunner: async ({ outputDir }: { outputDir: string }) => {
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
        return { message: "Text encoding warning on slide(s): 2.", textWarningPages: [2] };
      },
    };
    const preview = await new PptxPreviewService(options).buildPreview({ filePath: deckPath, renderMode: "full" });
    expect(preview.renderStatus).toBe("rendered");
    expect(preview.renderMessage).toContain("2");
    expect(preview.slides.every((slide) => slide.imageDataUrl)).toBe(true);
    const cached = await new PptxPreviewService(options).buildPreview({ filePath: deckPath, renderMode: "fast" });
    expect(cached.renderMessage).toBe(preview.renderMessage);
    expect(cached.textWarningPages).toEqual([2]);
    expect(cached.renderStatus).toBe("cached");
  });
  it("uses the bundled renderer without external dependencies, deduplicates requests and caches every slide", async () => {
    const deckPath = path.join(tempRoot, "deck.pptx");
    await createDeck(deckPath);
    const zip = await JSZip.loadAsync(await fs.readFile(deckPath));
    const xml = await zip.file("ppt/presentation.xml")!.async("string");
    zip.file("ppt/presentation.xml", xml.replace("</p:presentation>", '<p:extLst><p:ext uri="sections"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="Intro" id="section-1"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>'));
    await fs.writeFile(deckPath, await zip.generateAsync({ type: "nodebuffer" }));
    const source = await fs.readFile(deckPath);
    let calls = 0;
    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      officeCliRunner: async ({ outputDir }) => {
        calls++;
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), Buffer.from("second-slide"));
      },
      commandRunner: async () => { throw new Error("External renderer must not run"); },
      artifactToolRunner: async () => { throw new Error("External renderer must not run"); },
    });
    const [preview, concurrent] = await Promise.all([
      service.buildPreview({ filePath: deckPath, renderMode: "full" }),
      service.buildPreview({ filePath: deckPath, renderMode: "full" }),
    ]);
    expect(calls).toBe(1);
    expect(preview.renderStatus).toBe("rendered");
    expect(preview.renderer).toBe("officecli");
    expect(preview.slideCount).toBe(2);
    expect(preview.slides[0].text).toContain("Intro");
    expect(preview.slides[1].text).toContain("Findings");
    expect(concurrent.slides).toEqual(preview.slides);
    expect(preview.slides.every((slide) => slide.imageDataUrl)).toBe(true);
    expect(preview.slides[0].imageDataUrl).not.toBe(preview.slides[1].imageDataUrl);
    const cached = await service.buildPreview({ filePath: deckPath, renderMode: "fast" });
    expect(cached.renderStatus).toBe("cached");
    expect(cached.renderer).toBe("officecli");
    expect(cached.slideCount).toBe(2);
    expect(cached.slides).toEqual(preview.slides);
    expect(calls).toBe(1);
    expect(await fs.readFile(deckPath)).toEqual(source);
    expect((await fs.readdir(path.join(tempRoot, "cache"))).some((name) => name.startsWith("officecli-"))).toBe(false);
  });

  it("discards partial bundled output before trying another renderer", async () => {
    const deckPath = path.join(tempRoot, "deck.pptx");
    await createDeck(deckPath);
    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      officeCliRunner: async ({ outputDir }) => {
        await fs.writeFile(path.join(outputDir, "slide-9.png"), PNG_BYTES);
        throw new Error("Native render interrupted");
      },
      commandRunner: async () => { throw new Error("soffice unavailable"); },
      artifactToolRunner: async ({ outputDir }) => {
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
      },
    });
    const preview = await service.buildPreview({ filePath: deckPath, renderMode: "full" });
    expect(preview.renderStatus).toBe("rendered");
    expect(preview.slides).toHaveLength(2);
    expect(preview.slides.every((slide) => slide.imageDataUrl)).toBe(true);
  });

  it.each([0, 1])("rejects incomplete bundled output containing %s slides", async (count) => {
    const deckPath = path.join(tempRoot, "deck.pptx");
    await createDeck(deckPath);
    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      officeCliRunner: async ({ outputDir }) => {
        if (count) await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
      },
      commandRunner: async () => { throw new Error("soffice unavailable"); },
      artifactToolRunner: null,
    });
    const preview = await service.buildPreview({ filePath: deckPath, renderMode: "full" });
    expect(preview.renderStatus).toBe("text_only");
    expect(preview.renderMessage).toContain(count ? "Incomplete slide preview" : "No slide images were produced");
    expect((await service.buildPreview({ filePath: deckPath, renderMode: "fast" })).renderStatus).toBe("rendering");
  });

  it("renders non-PPTX PowerPoint files through the image fallback", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "legacy.ppt");
    await fs.writeFile(deckPath, Buffer.from("legacy powerpoint bytes"));

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async ({ outputDir }) => {
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
      },
      commandRunner: async () => {
        throw new Error("converter should not be needed");
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
      renderMode: "full",
    });

    expect(preview.slideCount).toBe(2);
    expect(preview.renderStatus).toBe("rendered");
    expect(preview.slides[0].imageDataUrl).toContain("data:image/png;base64,");
    expect(preview.slides[1].imageDataUrl).toContain("data:image/png;base64,");
    for (const renderMode of ["fast", "full"] as const) {
      const cached = await service.buildPreview({ filePath: deckPath, workspaceRoot: workspace, renderMode });
      expect(cached.slideCount).toBe(2);
      expect(cached.slides).toHaveLength(2);
      expect(cached.slides.every((slide) => slide.imageDataUrl)).toBe(true);
    }
  });

  it("returns fast text preview without rendering slide images", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async () => {
        calls.push("artifact-tool");
      },
      commandRunner: async (command) => {
        calls.push(command);
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
      renderMode: "fast",
    });

    expect(preview.slideCount).toBe(2);
    expect(preview.renderStatus).toBe("rendering");
    expect(preview.slides[0].text).toContain("Intro");
    expect(preview.slides[0].imageDataUrl).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("extracts structured slide text and speaker notes", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
      commandRunner: async () => {
        throw new Error("converter unavailable");
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });

    expect(preview.slideCount).toBe(2);
    expect(preview.renderStatus).toBe("text_only");
    expect(preview.slides[0].title).toContain("Intro");
    expect(preview.slides[0].notes).toContain("Presenter note A");
    expect(preview.slides[1].text).toContain("First point");
  });

  it("allows preview when the viewer passes a real file path for a symlinked workspace root", async () => {
    const realWorkspace = path.join(tempRoot, "workspace-real");
    const workspaceAlias = path.join(tempRoot, "workspace-alias");
    await fs.mkdir(realWorkspace, { recursive: true });
    try {
      await fs.symlink(realWorkspace, workspaceAlias, "dir");
    } catch {
      return;
    }
    const deckPath = path.join(realWorkspace, "deck.pptx");
    await createDeck(deckPath);
    const realDeckPath = await fs.realpath(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
      commandRunner: async () => {
        throw new Error("converter unavailable");
      },
    });

    const preview = await service.buildPreview({
      filePath: realDeckPath,
      workspaceRoot: workspaceAlias,
    });

    expect(preview.slideCount).toBe(2);
    expect(preview.renderStatus).toBe("text_only");
  });

  it("renders images once and reuses the preview cache", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
      commandRunner: async (command, args) => {
        calls.push(command);
        if (command === "soffice") {
          const outDir = String(args[args.indexOf("--outdir") + 1]);
          await fs.writeFile(path.join(outDir, "deck.pdf"), "%PDF");
          return;
        }
        if (command === "pdftoppm") {
          const outputPrefix = String(args[args.length - 1]);
          await fs.writeFile(`${outputPrefix}-1.png`, PNG_BYTES);
          await fs.writeFile(`${outputPrefix}-2.png`, PNG_BYTES);
          return;
        }
      },
    });

    const first = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });
    const second = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });

    expect(first.renderStatus).toBe("rendered");
    expect(first.slides[0].imageDataUrl).toContain("data:image/png;base64,");
    expect(second.renderStatus).toBe("rendered");
    expect(calls).toEqual(["soffice", "pdftoppm"]);
  });

  it("returns cached images during fast preview when render cache exists", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async ({ outputDir }) => {
        calls.push("artifact-tool");
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
      },
      commandRunner: async (command) => {
        calls.push(command);
      },
    });

    await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
      renderMode: "full",
    });
    const fast = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
      renderMode: "fast",
    });

    expect(fast.renderStatus).toBe("cached");
    expect(fast.slides[0].imageDataUrl).toContain("data:image/png;base64,");
    expect(calls).toEqual(["soffice", "artifact-tool"]);
  });

  it("shares concurrent full render work for the same deck", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async ({ outputDir }) => {
        calls.push("artifact-tool");
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
      },
      commandRunner: async (command) => {
        calls.push(command);
      },
    });

    const [first, second] = await Promise.all([
      service.buildPreview({
        filePath: deckPath,
        workspaceRoot: workspace,
        renderMode: "full",
      }),
      service.buildPreview({
        filePath: deckPath,
        workspaceRoot: workspace,
        renderMode: "full",
      }),
    ]);

    expect(first.renderStatus).toBe("rendered");
    expect(second.renderStatus).toBe("rendered");
    expect(calls).toEqual(["soffice", "artifact-tool"]);
  });

  it("prefers the faster LibreOffice renderer when available", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);
    const calls: string[] = [];

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: async ({ outputDir }) => {
        calls.push("artifact-tool");
        await fs.writeFile(path.join(outputDir, "slide-1.png"), PNG_BYTES);
        await fs.writeFile(path.join(outputDir, "slide-2.png"), PNG_BYTES);
      },
      commandRunner: async (command, args) => {
        calls.push(command);
        if (command === "soffice") {
          const outDir = String(args[args.indexOf("--outdir") + 1]);
          await fs.writeFile(path.join(outDir, "deck.pdf"), "%PDF");
          return;
        }
        if (command === "pdftoppm") {
          const outputPrefix = String(args[args.length - 1]);
          await fs.writeFile(`${outputPrefix}-1.png`, PNG_BYTES);
          await fs.writeFile(`${outputPrefix}-2.png`, PNG_BYTES);
        }
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });

    expect(preview.renderStatus).toBe("rendered");
    expect(preview.slides[0].imageDataUrl).toContain("data:image/png;base64,");
    expect(calls).toEqual(["soffice", "pdftoppm"]);
  });

  it("gives LibreOffice a private profile and a CJK-aware fontconfig", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "中文预览.pptx");
    await createDeck(deckPath);
    let sofficeArgs: string[] = [];
    let sofficeEnvironment: NodeJS.ProcessEnv | undefined;

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
      commandRunner: async (command, args, options) => {
        if (command === "soffice") {
          sofficeArgs = args;
          sofficeEnvironment = options.env;
          const outDir = String(args[args.indexOf("--outdir") + 1]);
          await fs.writeFile(path.join(outDir, "中文预览.pdf"), "%PDF");
          return;
        }
        if (command === "pdftoppm") {
          const outputPrefix = String(args[args.length - 1]);
          await fs.writeFile(`${outputPrefix}-1.png`, PNG_BYTES);
          await fs.writeFile(`${outputPrefix}-2.png`, PNG_BYTES);
        }
      },
    });

    await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
      renderMode: "full",
    });

    expect(sofficeArgs[0]).toMatch(/^-env:UserInstallation=file:\/\//);
    expect(sofficeEnvironment?.FONTCONFIG_FILE).toContain("fonts.conf");
    const fontconfig = await fs.readFile(
      String(sofficeEnvironment?.FONTCONFIG_FILE),
      "utf-8",
    );
    expect(fontconfig).toContain("PingFang SC");
    expect(fontconfig).toContain("Hiragino Sans GB");
    expect(fontconfig).toContain("Microsoft YaHei");
  });

  it("falls back to text-only preview when converters fail", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const deckPath = path.join(workspace, "deck.pptx");
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
      commandRunner: async () => {
        throw new Error("soffice missing");
      },
    });

    const preview = await service.buildPreview({
      filePath: deckPath,
      workspaceRoot: workspace,
    });

    expect(preview.renderStatus).toBe("text_only");
    expect(preview.renderMessage).toContain("soffice missing");
    expect(preview.slides[0].text).toContain("Intro");
  });

  it("rejects files outside the workspace", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const deckPath = path.join(outside, "deck.pptx");
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
    });

    await expect(
      service.buildPreview({
        filePath: deckPath,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/outside the workspace/);
  });

  it("allows a PPTX from the workspace's controlled durable mirror", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const durableRoot = path.join(tempRoot, "durable", "workspace-identity");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(durableRoot, { recursive: true });
    const deckPath = path.join(durableRoot, "artifacts", "deck.pptx");
    await fs.mkdir(path.dirname(deckPath), { recursive: true });
    await createDeck(deckPath);

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
      commandRunner: async () => {
        throw new Error("soffice missing");
      },
    });

    await expect(
      service.buildPreview({
        filePath: deckPath,
        workspaceRoot: workspace,
        allowedRoots: [durableRoot],
      }),
    ).resolves.toMatchObject({ slideCount: 2 });
  });

  it("rejects symlinked PPTX files that resolve outside the workspace", async () => {
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const deckPath = path.join(outside, "deck.pptx");
    await createDeck(deckPath);
    const linkPath = path.join(workspace, "linked.pptx");
    try {
      await fs.symlink(deckPath, linkPath);
    } catch {
      return;
    }

    const service = new PptxPreviewService({
      cacheRoot: path.join(tempRoot, "cache"),
      artifactToolRunner: null,
    });

    await expect(
      service.buildPreview({
        filePath: linkPath,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/outside the workspace/);
  });
});
