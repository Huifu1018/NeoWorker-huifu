import * as fs from "fs";
import * as path from "path";
import type { TaskEvent, TaskOutputSummary } from "../../shared/types";
import { extractArtifactPathCandidates } from "./step-contract";

const DELIVERY =
  /交付(?:文件|物)?|已完成|已(?:成功)?(?:生成|保存|导出|写入)|(?:delivered|deliverables|completed|saved|generated|exported)\b/i;
const NOT_DELIVERY =
  /(?:原文件|源文件|参考文件|输入文件|附件|未完成|未生成|尚未|不存在|失败|计划|准备|将要|如果|若需|可以|可选)|\b(?:source|input|attachment|reference|missing|failed|planned|could|would|if)\b/i;
const EXTENSIONS = new Set([
  ".pptx",
  ".ppt",
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".csv",
  ".html",
  ".htm",
  ".md",
  ".txt",
]);

/** Recover only explicit deliveries, never arbitrary filenames in assistant prose. */
export function verifyDeliveredArtifactSummary(
  summary: string,
  workspacePath: string,
  completedAt = Date.now(),
): TaskOutputSummary | undefined {
  if (!summary || !workspacePath || !Number.isFinite(completedAt))
    return undefined;
  let root: string;
  try {
    root = fs.realpathSync(workspacePath);
  } catch {
    return undefined;
  }
  const verified = new Set<string>();
  let deliverySection = false;
  for (const line of summary.slice(0, 80_000).split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s/.test(line);
    if (heading)
      deliverySection = DELIVERY.test(line) && !NOT_DELIVERY.test(line);
    if (NOT_DELIVERY.test(line)) continue;
    if (!deliverySection && !DELIVERY.test(line)) continue;
    for (const candidate of extractArtifactPathCandidates(line)) {
      if (verified.size >= 8) break;
      if (!EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) continue;
      const absolute = path.resolve(root, candidate);
      const relative = path.relative(root, absolute);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        continue;
      if (
        relative
          .split(path.sep)
          .some((part) => part.startsWith(".") || part === "node_modules")
      )
        continue;
      if (/^(?:test_min|__diag)(?:[._-]|$)/i.test(path.basename(relative)))
        continue;
      try {
        const real = fs.realpathSync(absolute);
        const realRelative = path.relative(root, real);
        if (
          !realRelative ||
          realRelative.startsWith("..") ||
          path.isAbsolute(realRelative)
        )
          continue;
        if (
          realRelative
            .split(path.sep)
            .some((part) => part.startsWith(".") || part === "node_modules")
        )
          continue;
        const stat = fs.statSync(real);
        if (
          !stat.isFile() ||
          stat.size === 0 ||
          stat.mtimeMs > completedAt + 2_000
        )
          continue;
        verified.add(relative.replace(/\\/g, "/"));
      } catch {
        /* A mention alone is not evidence that the file exists. */
      }
    }
  }
  const paths = [...verified];
  if (!paths.length) return undefined;
  return {
    created: [],
    modifiedFallback: paths,
    primaryOutputPath: paths[0],
    outputCount: paths.length,
    folders: [...new Set(paths.map((file) => path.dirname(file)))],
  };
}

/** Read-time repair keeps historical logs immutable and rechecks file existence. */
export function recoverVerifiedDeliveryEvents(
  events: TaskEvent[],
  taskId: string,
  workspacePath?: string,
): TaskEvent[] {
  if (!workspacePath) return events;
  return events.map((event) => {
    if (
      event.taskId !== taskId ||
      (event.legacyType || event.payload?.legacyType || event.type) !==
        "task_completed"
    )
      return event;
    const payload = event.payload;
    if (payload?.outputSummary?.outputCount > 0) return event;
    if (
      payload?.terminalStatus &&
      !["ok", "partial_success"].includes(payload.terminalStatus)
    )
      return event;
    const summary =
      typeof payload?.resultSummary === "string" ? payload.resultSummary : "";
    const outputSummary = verifyDeliveredArtifactSummary(
      summary,
      workspacePath,
      event.timestamp,
    );
    if (!outputSummary) return event;
    return {
      ...event,
      payload: {
        ...payload,
        outputSummary,
        ...(payload.bestKnownOutcome
          ? { bestKnownOutcome: { ...payload.bestKnownOutcome, outputSummary } }
          : {}),
        deliveryEvidenceSource: "verified_existing_files",
      },
    };
  });
}
