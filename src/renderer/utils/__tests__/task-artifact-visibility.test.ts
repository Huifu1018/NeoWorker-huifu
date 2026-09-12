import { describe, expect, it } from "vitest";
import {
  isInternalWorkspaceProcessPath,
  isUserVisibleTaskArtifactPath,
} from "../task-artifact-visibility";

describe("isUserVisibleTaskArtifactPath", () => {
  it("hides Office staging, quality, and manifest internals", () => {
    expect(
      isUserVisibleTaskArtifactPath(
        ".neoworker/office-staging/job/job.pptx",
      ),
    ).toBe(false);
    expect(
      isUserVisibleTaskArtifactPath(
        ".neoworker/office-quality/artifact/slide-1.png",
      ),
    ).toBe(false);
    expect(
      isUserVisibleTaskArtifactPath(
        ".neoworker/office-manifests/artifact.json",
      ),
    ).toBe(false);
    expect(
      isUserVisibleTaskArtifactPath(
        ".neoworker/office-snapshots/snapshot-1.json",
      ),
    ).toBe(false);
  });

  it("hides presentation sources while keeping the published deck", () => {
    expect(isUserVisibleTaskArtifactPath("slide-15.mjs")).toBe(false);
    expect(isUserVisibleTaskArtifactPath("presentation-plan.json")).toBe(false);
    expect(isUserVisibleTaskArtifactPath("narrative.md")).toBe(false);
    expect(isUserVisibleTaskArtifactPath("ppt-master/scripts/build_ppt.py")).toBe(false);
    expect(isUserVisibleTaskArtifactPath("ppt-master/review/report.json")).toBe(false);
    expect(isUserVisibleTaskArtifactPath("融资分析报告.pptx")).toBe(true);
  });

  it("does not hide ordinary user-requested documents", () => {
    expect(isUserVisibleTaskArtifactPath("research/report.md")).toBe(true);
    expect(isUserVisibleTaskArtifactPath("data/metrics.json")).toBe(true);
  });

  it("hides office chunk checkpoints and root process directories", () => {
    expect(isUserVisibleTaskArtifactPath("s1_h.json")).toBe(false);
    expect(isUserVisibleTaskArtifactPath("s2_r17_31.json")).toBe(false);
    expect(isUserVisibleTaskArtifactPath("s1_r01_05.json")).toBe(false);
    expect(isUserVisibleTaskArtifactPath("translation-summary.json")).toBe(
      true,
    );

    expect(
      isInternalWorkspaceProcessPath(
        "/tmp/finance-workspace/s1_r01_05.json",
        "/tmp/finance-workspace",
      ),
    ).toBe(true);
    expect(
      isInternalWorkspaceProcessPath(
        "/tmp/finance-workspace/pptxwork",
        "/tmp/finance-workspace",
      ),
    ).toBe(true);
    expect(
      isInternalWorkspaceProcessPath(
        "/tmp/finance-workspace/tr",
        "/tmp/finance-workspace",
      ),
    ).toBe(true);
    expect(
      isInternalWorkspaceProcessPath(
        "/tmp/finance-workspace/research/tr/report.json",
        "/tmp/finance-workspace",
      ),
    ).toBe(false);
  });
});
