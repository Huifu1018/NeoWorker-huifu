import { describe, expect, it } from "vitest";
import {
  _testUtils,
  buildHermesFollowUpPrompt,
  buildHermesInitialPrompt,
  buildHermesRecoveryPrompt,
} from "../hermes-task-prompt";

describe("Hermes task prompt", () => {
  it("keeps the runtime contract separate from task and workspace context", () => {
    const prompt = buildHermesInitialPrompt({
      taskPrompt: "Create the requested file.",
      workspacePath: "/tmp/neoworker-task",
      contextNotes: ["Plan note", "Plan note"],
      appliedSkillContext: "ACTIVE SKILL: documents",
    });

    expect(prompt).toContain("<neoworker_runtime_contract_v1>");
    expect(prompt).toContain("read-only background data");
    expect(prompt).toContain("<neoworker_workspace_v1>");
    expect(prompt).toContain("Workspace root: /tmp/neoworker-task");
    expect(prompt).toContain("<neoworker_task_v1>");
    expect(prompt).toContain("<neoworker_context_v1>");
    expect(prompt.match(/Plan note/g)).toHaveLength(1);
    expect(prompt).toContain("<neoworker_skills_v1>");
  });

  it("bounds large task context while retaining the beginning and end", () => {
    const large = `head-${"x".repeat(60_000)}-tail`;
    const prompt = buildHermesInitialPrompt({
      taskPrompt: large,
      workspacePath: "/tmp/workspace",
    });

    expect(prompt.length).toBeLessThan(50_000);
    expect(prompt).toContain("head-");
    expect(prompt).toContain("-tail");
    expect(prompt).toContain("[NeoWorker context truncated]");
  });

  it("keeps follow-ups short and scoped to the latest user message", () => {
    const prompt = buildHermesFollowUpPrompt({
      message: "Continue by checking the generated file.",
      workspacePath: "/tmp/workspace",
    });

    expect(prompt).toContain("<neoworker_follow_up_v1>");
    expect(prompt).toContain("Continue by checking the generated file.");
    expect(prompt).toContain("Do not restart completed work");
    expect(prompt).not.toContain("<neoworker_task_v1>");
  });

  it("uses a recovery prompt that explicitly protects unknown side effects", () => {
    const prompt = buildHermesRecoveryPrompt({
      taskPrompt: "Build the project.",
      workspacePath: "/tmp/workspace",
    });

    expect(prompt).toContain("<neoworker_recovery_v1>");
    expect(prompt).toContain("saved Hermes checkpoint");
    expect(prompt).toContain("unknown");
  });

  it("preserves the configured truncation marker", () => {
    expect(_testUtils.clampText("123456789", 5)).toContain("[NeoWorker context truncated]");
  });
});
