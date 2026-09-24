import { createElement, useEffect, useMemo, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ActiveArtifactContext, TaskEvent } from "../../../shared/types";
import { findReplacementArtifactForCompletedFollowUp } from "../artifact-followup";

// Exercise the state/effect cycle used by the preview, not just one lookup.
describe("completed artifact preview render cycle", () => {
  it.each(["pdf", "xlsx"])("settles when a completed task has two %s revisions", async (ext) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const kind = ext === "pdf" ? "document" : "spreadsheet";
    const events = [
      ...["report", "report-v2"].map((name, i) => ({
        id: name,
        taskId: "task",
        timestamp: 200 + i,
        type: "timeline_artifact_emitted",
        schemaVersion: 2,
        payload: { path: `${name}.${ext}`, legacyType: "artifact_created" },
      })),
      { id: "done", taskId: "task", timestamp: 210, type: "task_completed", payload: {} },
    ] as TaskEvent[];
    let renders = 0;
    function Preview() {
      if (++renders > 10) throw new Error("Preview never settled");
      const [current, setCurrent] = useState<ActiveArtifactContext>({
        kind,
        path: `report.${ext}`,
      });
      const next = useMemo(
        () => findReplacementArtifactForCompletedFollowUp({ current, events, turnStartedAt: 100 }),
        [current],
      );
      useEffect(() => {
        if (next) setCurrent(next);
      }, [next]);
      return createElement("span", null, current.path);
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(Preview));
      });
      expect(renderer!.toJSON()).toMatchObject({ children: [`report-v2.${ext}`] });
      expect(renders).toBeLessThanOrEqual(3);
      expect(errors.mock.calls.flat().join(" ")).not.toContain("Maximum update depth");
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      errors.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
