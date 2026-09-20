import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeArtifactCard } from "../CodeArtifactCard";
import { isCodeArtifactFile } from "../../../shared/code-formats";
import { collectEndOfTaskArtifactCardStacks, extractGeneratedArtifactPathsFromText, getInlinePreviewKindForGeneratedFile } from "../MainContent/artifact-logic";
import type { TaskEvent } from "../../../shared/types";

function event(id: string, type: TaskEvent["type"], payload: Record<string, unknown>): TaskEvent {
  return { id, taskId: "code-task", timestamp: Number(id), type, payload } as TaskEvent;
}

describe("code deliverable cards", () => {
  it("renders a Windows Python deliverable with its file name and code icon", () => {
    const html = renderToStaticMarkup(React.createElement(CodeArtifactCard, {
      filePath: "C:\\Users\\CHENDA~1\\Temp\\ui-session-UnYPzD\\docker_cheatsheet.py",
      workspacePath: "C:\\Users\\CHENDA~1\\Temp\\ui-session-UnYPzD",
      onOpenViewer: () => {},
    }));
    expect(html).toContain("code-artifact-card");
    expect(html).toContain("artifact-file-type-icon-code");
    expect(html).toContain("docker_cheatsheet.py");
    expect(html).toContain(">PY<");
    expect(html).not.toContain("Microsoft Word");
  });

  it("projects an edited Python output into its own completed turn, without an old document", () => {
    const file = "C:\\workspace\\docker_cheatsheet.py";
    const stream = [
      event("1", "user_message", { message: "翻译文件" }),
      event("2", "file_created", { path: "old.docx" }),
      event("3", "task_completed", { outputSummary: { created: ["old.docx"], outputCount: 1 } }),
      event("4", "user_message", { message: "帮我优化一下这个代码" }),
      event("5", "file_modified", { path: file }),
      event("6", "assistant_message", { message: `已完成优化。交付文件：\`${file}\`` }),
      event("7", "task_completed", { outputSummary: { created: [], modifiedFallback: [file], primaryOutputPath: file, outputCount: 1 } }),
    ];
    const stacks = collectEndOfTaskArtifactCardStacks(stream);
    expect(stacks).toHaveLength(2);
    expect(stacks[1].artifacts).toHaveLength(1);
    expect(stacks[1].artifacts[0]).toMatchObject({ kind: "code", path: "C:/workspace/docker_cheatsheet.py" });
  });

  it("does not promote uncreated source mentions or internal helper scripts", () => {
    const stream = [
      event("1", "user_message", { message: "制作报告" }),
      event("2", "file_created", { path: ".neoworker/tmp/make_report.py" }),
      event("3", "assistant_message", { message: "可另存为 demo.py" }),
      event("4", "task_completed", { outputSummary: { created: [], outputCount: 0 } }),
    ];
    expect(collectEndOfTaskArtifactCardStacks(stream)).toEqual([]);
  });

  it("recognizes generated Windows paths and does not truncate longer source extensions", () => {
    expect(extractGeneratedArtifactPathsFromText("已保存文件：`C:\\workspace\\代码.py` 和 component.tsx、worker.pyw"))
      .toEqual(["C:\\workspace\\代码.py", "component.tsx", "worker.pyw"]);
    expect(getInlinePreviewKindForGeneratedFile({ path: "output.PY" })).toBe("code");
    expect(isCodeArtifactFile("directory.py/file")).toBe(false);
    expect(isCodeArtifactFile("directory.py/py")).toBe(false);
  });
});
