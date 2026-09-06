import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverHtmlArtifactFromFragments } from "../html-artifact-recovery";

const temporaryRoots: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-html-recovery-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("recoverHtmlArtifactFromFragments", () => {
  it("assembles staged HTML fragments without invoking a shell script", () => {
    const workspace = makeWorkspace();
    const fragments = path.join(workspace, ".neoworker", "tmp", "fragments");
    fs.mkdirSync(fragments, { recursive: true });
    fs.writeFileSync(
      path.join(fragments, "00_head.html"),
      '<!doctype html><html><head><meta charset="utf-8"><title>Report</title></head><body>',
    );
    fs.writeFileSync(
      path.join(fragments, "01_body.html"),
      "<section><h1>Report</h1><p>Data loaded.</p></section>",
    );
    fs.writeFileSync(path.join(fragments, "02_tail.html"), "</body></html>");

    const result = recoverHtmlArtifactFromFragments({
      workspacePath: workspace,
      targetPath: "report.html",
      prompt: "生成静态 HTML 报告",
    });

    expect(result.success).toBe(true);
    expect(result.fragmentCount).toBe(3);
    expect(fs.readFileSync(path.join(workspace, "report.html"), "utf8")).toContain(
      "Data loaded.",
    );
  });

  it("fills an existing HTML placeholder and rejects incomplete fragments", () => {
    const workspace = makeWorkspace();
    const fragments = path.join(workspace, ".neoworker", "tmp", "parts");
    fs.mkdirSync(fragments, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "report.html"),
      '<!doctype html><html><body><!-- NEOMORE --></body></html>',
    );
    fs.writeFileSync(
      path.join(fragments, "part1.html"),
      "<section><h2>第一部分</h2><p>这是足够长的实际内容。</p></section>",
    );
    fs.writeFileSync(
      path.join(fragments, "part2.html"),
      "<section><h2>第二部分</h2><p>这是另一段实际内容。</p></section>",
    );

    const result = recoverHtmlArtifactFromFragments({
      workspacePath: workspace,
      targetPath: "report.html",
      prompt: "生成静态 HTML 报告",
    });

    expect(result.success).toBe(true);
    const output = fs.readFileSync(path.join(workspace, "report.html"), "utf8");
    expect(output).toContain("第一部分");
    expect(output).toContain("第二部分");
    expect(output).not.toContain("NEOMORE");
  });

  it("does not assemble a single partial fragment", () => {
    const workspace = makeWorkspace();
    const fragments = path.join(workspace, ".neoworker", "tmp", "fragments");
    fs.mkdirSync(fragments, { recursive: true });
    fs.writeFileSync(path.join(fragments, "00_head.html"), "<html><body>");

    const result = recoverHtmlArtifactFromFragments({
      workspacePath: workspace,
      targetPath: "report.html",
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(workspace, "report.html"))).toBe(false);
  });
});
