import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import {
  recoverVerifiedDeliveryEvents,
  verifyDeliveredArtifactSummary,
} from "../verified-delivery-artifacts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "verified-delivery-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const delivery = (file: string) =>
  `上一步的任务已完成。我已确认交付物仍在工作区。\n\n## 已完成\n**\`${file}\`**（工作区根目录）\n\n## 下一步\n可以继续处理。`;

describe("verified delivery artifacts", () => {
  it.each(["xlsx", "pptx", "pdf", "docx", "html"])(
    "recovers an existing %s explicitly delivered after continue",
    (extension) => {
      const file = `Marketing Cases - 王超 (EN).${extension}`;
      fs.writeFileSync(path.join(root, file), "existing artifact");
      fs.utimesSync(path.join(root, file), 1, 1);
      fs.writeFileSync(path.join(root, "unrelated.pdf"), "old report");
      expect(
        verifyDeliveredArtifactSummary(delivery(file), root)?.modifiedFallback,
      ).toEqual([file]);
    },
  );

  it.each([
    "原文件：`source.xlsx`",
    "参考文件：`source.xlsx`",
    "计划生成 `source.xlsx`",
    "文件不存在：`source.xlsx`",
    "若需可以导出 `source.xlsx`",
    "## 已完成\n原文件：`source.xlsx`",
    "## 交付文件\n## 输入文件\n`source.xlsx`",
    "## 已完成\n## 下一步\n`source.xlsx`",
    "## Deliverables\nSource: `source.xlsx`",
  ])("does not promote non-delivery prose: %s", (summary) => {
    fs.writeFileSync(path.join(root, "source.xlsx"), "source");
    expect(verifyDeliveredArtifactSummary(summary, root)).toBeUndefined();
  });

  it("rejects missing, empty, directory, internal, diagnostic and escaping files", () => {
    fs.writeFileSync(path.join(root, "empty.xlsx"), "");
    fs.mkdirSync(path.join(root, "directory.xlsx"));
    fs.mkdirSync(path.join(root, ".neoworker"));
    fs.writeFileSync(path.join(root, ".neoworker", "source.xlsx"), "upload");
    fs.writeFileSync(path.join(root, "test_min.pptx"), "test");
    fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
    for (const file of [
      "missing.xlsx",
      "empty.xlsx",
      "directory.xlsx",
      ".neoworker/source.xlsx",
      "test_min.pptx",
      "../escape.pdf",
      "outside/file.pdf",
    ]) {
      expect(
        verifyDeliveredArtifactSummary(delivery(file), root),
      ).toBeUndefined();
    }
  });

  it("does not attach a newly created file to an older completion", () => {
    fs.writeFileSync(path.join(root, "future.xlsx"), "new");
    expect(
      verifyDeliveredArtifactSummary(delivery("future.xlsx"), root, 1),
    ).toBeUndefined();
  });

  it("repairs only matching empty completions without mutating persisted events", () => {
    fs.writeFileSync(path.join(root, "report.xlsx"), "existing");
    const event = {
      id: "completed",
      taskId: "task",
      timestamp: Date.now(),
      type: "timeline_step_finished",
      legacyType: "task_completed",
      payload: {
        resultSummary: delivery("report.xlsx"),
        outputSummary: { created: [], outputCount: 0, folders: [] },
      },
    } as TaskEvent;
    const before = JSON.stringify(event);
    const [recovered] = recoverVerifiedDeliveryEvents([event], "task", root);
    expect(recovered.payload.outputSummary.primaryOutputPath).toBe(
      "report.xlsx",
    );
    expect(JSON.stringify(event)).toBe(before);
    expect(recoverVerifiedDeliveryEvents([event], "other-task", root)[0]).toBe(
      event,
    );
    expect(recoverVerifiedDeliveryEvents([recovered], "task", root)[0]).toBe(
      recovered,
    );
    fs.unlinkSync(path.join(root, "report.xlsx"));
    expect(recoverVerifiedDeliveryEvents([event], "task", root)[0]).toBe(event);
  });
});
