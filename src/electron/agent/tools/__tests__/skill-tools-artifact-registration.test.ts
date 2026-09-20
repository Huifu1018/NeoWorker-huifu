import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import PptxGenJS from "pptxgenjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";

const mocks = vi.hoisted(() => ({
  createPresentation: vi.fn(),
  qualityCheck: vi.fn(),
}));

vi.mock("../../skills/spreadsheet", () => ({
  SpreadsheetBuilder: class {
    async create(): Promise<void> {}
  },
}));

vi.mock("../../skills/document", () => ({
  DocumentBuilder: class {
    async create(): Promise<void> {}
  },
}));

vi.mock("../../skills/presentation", () => ({
  PresentationBuilder: class {
    create = mocks.createPresentation;
  },
}));

vi.mock("../../skills/organizer", () => ({
  FolderOrganizer: class {
    async organize(): Promise<number> {
      return 0;
    }
  },
}));

vi.mock("../../../utils/office-document-quality", () => ({
  runOfficeDocumentQualityCheck: mocks.qualityCheck,
}));

import {
  buildPublishedOfficeArtifactReminder,
  shouldRetryOfficeArtifactBuild,
  SkillTools,
} from "../skill-tools";

describe("Office artifact retry policy", () => {
  it("keeps content defects visible even after structural release gates pass", () => {
    const reminder = buildPublishedOfficeArtifactReminder({
      available: true, engine: "officecli", status: "passed",
      warnings: [], durationMs: 1, summary: "Rendered", modelGuidance: "Review source evidence.",
      contentReview: {
        status: "issues", message: "Check source figures",
        findings: [{ type: "repeated-figure-caption", severity: "warning", path: "word/document.xml", message: "Repeated captions" }],
      },
    }, { status: "published", quality: { score: { hardGatePassed: true } } });
    expect(reminder).toContain("contentReview.findings");
    expect(reminder).toContain("without regenerating unchanged content");
    expect(reminder).toContain("do not claim a fully verified report");
    expect(reminder).not.toContain("published successfully");
  });

  it("never repeats integrity or quality failures without a source mutation", () => {
    expect(shouldRetryOfficeArtifactBuild("INTEGRITY_FAILED")).toBe(false);
    expect(shouldRetryOfficeArtifactBuild("QUALITY_FAILED")).toBe(false);
  });

  it("allows one caller-bounded retry for transient build failures", () => {
    expect(shouldRetryOfficeArtifactBuild("BUILD_FAILED")).toBe(true);
    expect(shouldRetryOfficeArtifactBuild("EMPTY_OUTPUT")).toBe(true);
  });

  it("does not instruct the model to regenerate a published artifact for advisory issues", () => {
    const reminder = buildPublishedOfficeArtifactReminder(
      {
        available: true,
        engine: "officecli",
        status: "issues",
        validation: { passed: true },
        issueCount: 9,
        issues: [{ severity: 1, message: "Formatting recommendation" }],
        warnings: [],
        durationMs: 1,
        summary: "advisory issues",
        modelGuidance: "repair",
      },
      {
        status: "published",
        quality: { score: { hardGatePassed: true } },
      },
    );

    expect(reminder).toContain("advisory recommendations");
    expect(reminder).toContain("do not regenerate unchanged content");
  });
});

describe("SkillTools artifact registration", () => {
  let tempDir = "";

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  it("fills a source template without generationMode and isolates later outputs", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-native-template-"));
    const daemon = { logEvent: vi.fn(), registerArtifact: vi.fn() };
    const tools = new SkillTools({ path: tempDir, permissions: { read: true, write: true } } as Workspace, daemon as never, "task-template");
    const fill = vi.spyOn(tools as Any, "runPptMasterTemplateFill").mockImplementation(async (_source: string, root: string, _slides: unknown[], filename: string) => ({ outputPath: path.join(root, "output", filename), size: 200 }));
    vi.spyOn(tools as Any, "inspectOfficeArtifact").mockResolvedValue({ status: "passed", validation: { passed: true } });
    const builder = vi.spyOn(tools as Any, "createOfficeArtifactBuilder");
    const input = { filename: "analysis.pptx", sourcePath: "template(2).pptx", slides: [{ title: "Title", content: ["Body"], imagePath: "figure.png" }] };
    const first = await tools.createPresentation(input);
    const second = await tools.createPresentation(input);
    expect(fill).toHaveBeenCalledTimes(2);
    expect(fill.mock.calls[0][2]).toEqual(expect.arrayContaining([expect.objectContaining({ imagePath: path.join(tempDir, "figure.png") })]));
    expect(first.path).toMatch(/analysis\.pptx$/);
    expect(second.path).not.toBe(first.path);
    expect(builder).not.toHaveBeenCalled();
    expect(daemon.registerArtifact).toHaveBeenCalledTimes(2);
  });

  it("retains every source page for precise edits, including otherwise empty slides", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-native-edit-"));
    const daemon = { logEvent: vi.fn(), registerArtifact: vi.fn() };
    const tools = new SkillTools({ path: tempDir, permissions: { write: true } } as Workspace, daemon as never, "edit");
    const fill = vi.spyOn(tools as Any, "runPptMasterTemplateFill").mockResolvedValue({ outputPath: path.join(tempDir, "output.pptx"), size: 200 });
    vi.spyOn(tools as Any, "inspectOfficeArtifact").mockResolvedValue({ status: "issues", validation: { passed: true }, issues: [{ message: "Mixed punctuation" }] });
    const slides = [{ title: "Existing", templateReplacements: [{ shapeId: "6", text: "Concise body" }] }, { title: "Unchanged" }];
    const result = await tools.createPresentation({ filename: "edited.pptx", sourcePath: "source.pptx", preserveSlideStructure: true, slides });
    expect(fill.mock.calls[0][2]).toEqual(slides);
    expect(fill.mock.calls[0][5]).toBe(true);
    expect(result._modelReminder).toContain("does not prove visual correctness");
    const roots = await fs.readdir(path.join(tempDir, "artifacts/skills/edit/ppt-master"));
    const report = JSON.parse(await fs.readFile(path.join(tempDir, "artifacts/skills/edit/ppt-master", roots[0], "validation/pptx-delivery-check.json"), "utf8"));
    expect(report.status).toBe("passed-with-advisories");
  });

  it("keeps an overflowing template as a draft without publishing or writing a passed ledger", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-native-overflow-"));
    const daemon = { logEvent: vi.fn(), registerArtifact: vi.fn() };
    const tools = new SkillTools({ path: tempDir, permissions: { write: true } } as Workspace, daemon as never, "edit");
    vi.spyOn(tools as Any, "runPptMasterTemplateFill").mockResolvedValue({ outputPath: path.join(tempDir, "draft.pptx"), size: 200 });
    vi.spyOn(tools as Any, "inspectOfficeArtifact").mockResolvedValue({ status: "issues", validation: { passed: true }, issues: [{ path: "/slide[1]/shape[3]", message: "text overflow: 12 lines in KPI" }] });
    await expect(tools.createPresentation({ filename: "edited.pptx", sourcePath: "source.pptx", slides: [{ title: "Title", content: ["Body"] }] })).rejects.toThrow(/shape\[3\].*Draft retained/s);
    expect(daemon.registerArtifact).not.toHaveBeenCalled();
    expect(daemon.logEvent.mock.calls.some(call => call[1] === "artifact_created")).toBe(false);
  });

  it("never substitutes a built-in deck after native filling fails", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-native-template-"));
    const daemon = { logEvent: vi.fn(), registerArtifact: vi.fn() };
    const tools = new SkillTools({ path: tempDir, permissions: { write: true } } as Workspace, daemon as never, "task-template");
    vi.spyOn(tools as Any, "runPptMasterTemplateFill").mockRejectedValue(new Error("invalid template"));
    const builder = vi.spyOn(tools as Any, "createOfficeArtifactBuilder");
    await expect(tools.createPresentation({ filename: "analysis.pptx", sourcePath: "template.pptx", slides: [{ title: "Title" }] })).rejects.toThrow("invalid template");
    expect(builder).not.toHaveBeenCalled();
    expect(daemon.registerArtifact).not.toHaveBeenCalled();
  });

  it("preserves managed subdirectories and registers a generated presentation", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-skill-tools-"));
    const visualEvidencePath = path.join(tempDir, "quality-evidence.png");
    await fs.writeFile(
      visualEvidencePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAE/wJ/l2BNWAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    mocks.createPresentation.mockImplementation(async (outputPath: string) => {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      const deck = new PptxGenJS();
      const slide = deck.addSlide();
      slide.addText("Title", { x: 1, y: 1, w: 8, h: 1 });
      slide.addText("Body", { x: 1, y: 2, w: 8, h: 2 });
      await deck.writeFile({ fileName: outputPath });
    });
    mocks.qualityCheck.mockResolvedValue({
      available: true,
      status: "passed",
      issueCount: 0,
      issues: [],
      warnings: [],
      durationMs: 1,
      summary: "validated",
      validation: { passed: true, message: "Validation passed" },
      engine: "officecli",
      modelGuidance: "verified",
      visual: {
        required: true,
        passed: true,
        renderer: "officecli",
        evidencePath: visualEvidencePath,
        summary: "Visual evidence captured",
      },
    });

    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: tempDir,
      permissions: { read: true, write: true, shell: true },
    } as Workspace;
    const daemon = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
    };
    const tools = new SkillTools(workspace, daemon as never, "task-1");
    vi.spyOn(tools as Any, "createOfficeArtifactBuilder").mockReturnValue({ createPresentation: mocks.createPresentation });

    const result = await tools.createPresentation({
      filename: ".neoworker/report.pptx",
      slides: [{ title: "Title", content: ["Body"] }],
    });

    const absoluteOutputPath = path.join(tempDir, ".neoworker", "report.pptx");
    expect(result.path.replace(/\\/g, "/")).toBe(".neoworker/report.pptx");
    expect(daemon.registerArtifact).toHaveBeenCalledWith(
      "task-1",
      absoluteOutputPath,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "artifact_created",
      expect.objectContaining({
        path: result.path,
        type: "presentation",
      }),
    );
  });
});
