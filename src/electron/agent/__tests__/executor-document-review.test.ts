import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { TaskExecutor } from "../executor";
import { reviewDocxDeliverables } from "../../utils/docx-delivery-review";

const dirs: string[] = [];
const xml = (bad: boolean) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${Array.from({ length: 3 }, (_, i) => `<w:p><w:r><w:t>图：${bad ? '通用图注' : `不同主题${i}`}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
async function writeReport(file: string, bad: boolean) {
  await fs.writeFile(file, await new JSZip().file("word/document.xml", xml(bad)).generateAsync({ type: "nodebuffer" }));
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docx-delivery-"));
  dirs.push(root);
  const file = path.join(root, "report.docx");
  await writeReport(file, true);
  const instance = Object.create(TaskExecutor.prototype) as Any;
  instance.workspace = { path: root };
  instance.task = { id: "report-task", rawPrompt: "基于材料生成 Word 分析报告" };
  instance.activeFollowUpCompletionContract = { requiresArtifactEvidence: true, requiredArtifactExtensions: [".docx"] };
  instance.toolRegistry = { getDocumentTaskContext: () => instance.task.rawPrompt };
  instance.abortController = new AbortController();
  instance.getFollowUpArtifactEvidencePaths = vi.fn(() => ["report.docx"]);
  instance.resolveArtifactPathForInspection = (value: string) => path.resolve(root, value);
  instance.taskRequiresSimplifiedChineseOutput = () => true;
  instance.emitEvent = vi.fn();
  const result = { assistantText: "报告已生成", stopReason: "end_turn", sessionId: "test" };
  const runtime = { prompt: vi.fn(async () => result) };
  return { instance, runtime, result, root, file };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("document delivery checkpoint", () => {
  it("cancels an overlong correction without extending the turn indefinitely", async () => {
    const { instance, runtime } = await setup();
    vi.useFakeTimers();
    runtime.prompt.mockImplementation((_text: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const promise = instance.promptHermesDocumentRepair(runtime, "repair");
    const assertion = expect(promise).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is invoked by the normal runtime completion path for newly created reports", async () => {
    const { instance, runtime, result, file } = await setup();
    instance.runHermesPromptWithTransientRetry = vi.fn(async () => { await writeReport(file, true); return result; });
    instance.isLikelyIntermediateHermesResponse = () => false;
    const output = await instance.runHermesPromptToCompletion(runtime, "生成报告", false, "follow_up");
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    expect(output.assistantText).toContain("仍需核对");
  });

  it("adds no extra model call for a clean report", async () => {
    const { instance, runtime, result, file } = await setup();
    await writeReport(file, false);
    expect(await instance.reviewHermesDocumentDelivery(runtime, result, Date.now())).toBe(result);
    expect(runtime.prompt).not.toHaveBeenCalled();
  });

  it("reviews shell-created DOCX files and stops after one unchanged correction", async () => {
    const { instance, runtime, result } = await setup();
    const output = await instance.reviewHermesDocumentDelivery(runtime, result, Date.now());
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    expect(runtime.prompt.mock.calls[0][0]).toContain("one targeted correction pass");
    expect(output.assistantText).toContain("仍需核对");
    expect(output.assistantText).toContain("多张图片使用相同图注");
  });

  it("rechecks actual bytes and accepts a corrected document without a stale warning", async () => {
    const { instance, runtime, result, file } = await setup();
    runtime.prompt.mockImplementation(async () => { await writeReport(file, false); return result; });
    const output = await instance.reviewHermesDocumentDelivery(runtime, result, Date.now());
    expect(output.assistantText).toBe(result.assistantText);
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite translations to satisfy report formatting heuristics", async () => {
    const { instance, runtime, result } = await setup();
    instance.task.rawPrompt = "把 Word 文档翻译成韩语，保持原格式";
    expect(await instance.reviewHermesDocumentDelivery(runtime, result, Date.now())).toBe(result);
    expect(runtime.prompt).not.toHaveBeenCalled();
  });

  it("does not scan or change earlier conversation artifacts", async () => {
    const { instance, runtime, result, file } = await setup();
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect(await instance.reviewHermesDocumentDelivery(runtime, result, Date.now())).toBe(result);
    expect(runtime.prompt).not.toHaveBeenCalled();
  });

  it("does not lose a deliverable when the correction request fails", async () => {
    const { instance, runtime, result, file } = await setup();
    runtime.prompt.mockRejectedValue(new Error("timeout"));
    const output = await instance.reviewHermesDocumentDelivery(runtime, result, Date.now());
    expect(output.assistantText).toContain("仍需核对");
    expect((await fs.stat(file)).size).toBeGreaterThan(0);
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
  });

  it("never treats deletion as a successful correction", async () => {
    const { instance, runtime, result, file } = await setup();
    runtime.prompt.mockImplementation(async () => { await fs.unlink(file); return result; });
    const output = await instance.reviewHermesDocumentDelivery(runtime, result, Date.now());
    expect(output.assistantText).toContain("未完成内容检查");
  });

  it("honors cancellation before review or after a repair request", async () => {
    const { instance, runtime, result } = await setup();
    instance.cancelled = true;
    await instance.reviewHermesDocumentDelivery(runtime, result, Date.now());
    expect(runtime.prompt).not.toHaveBeenCalled();
    instance.cancelled = false;
    runtime.prompt.mockImplementation(async () => { instance.cancelled = true; return { ...result, stopReason: "cancelled" }; });
    const output = await instance.reviewHermesDocumentDelivery(runtime, result, Date.now());
    expect(output.stopReason).toBe("cancelled");
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
  });

  it("excludes uploads, traversal and symlinks leaving the workspace", async () => {
    const { root, file } = await setup();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "docx-outside-"));
    dirs.push(outside);
    const external = path.join(outside, "external.docx");
    await writeReport(external, true);
    await fs.mkdir(path.join(root, ".neoworker", "uploads"), { recursive: true });
    await fs.copyFile(file, path.join(root, ".neoworker", "uploads", "source.docx"));
    await fs.symlink(external, path.join(root, "linked.docx"));
    expect(await reviewDocxDeliverables(root, [".neoworker/uploads/source.docx", path.relative(root, external), "linked.docx"])).toEqual([]);
  });
});
