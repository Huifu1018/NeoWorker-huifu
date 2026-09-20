import { describe, expect, it } from "vitest";
import {
  _testUtils,
  buildHermesFollowUpPrompt,
  buildHermesInitialPrompt,
  buildHermesRecoveryPrompt,
} from "../hermes-task-prompt";

describe("Hermes task prompt", () => {
  it("carries the same identity and filesystem evidence rules through every entry point", () => {
    const prompts = [
      buildHermesInitialPrompt({ taskPrompt: "Who are you?", workspacePath: "/tmp/work" }),
      buildHermesInitialPrompt({ taskPrompt: "Continue", workspacePath: "/tmp/work", resuming: true }),
      buildHermesFollowUpPrompt({ message: "Where is .hermes?", workspacePath: "C:\\work" }),
      buildHermesRecoveryPrompt({ taskPrompt: "Continue", workspacePath: "C:\\work" }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("Your user-facing identity is NeoWorker");
      expect(prompt).toContain("Hermes is the embedded engine, not your name");
      expect(prompt).toContain("configuration alone does not prove file existence or creation history");
      expect(prompt).toContain("Use the language of the latest user message");
      expect(prompt).toContain("translation target applies to its translated content only");
    }
  });
  it("keeps the runtime contract separate from task and workspace context", () => {
    const prompt = buildHermesInitialPrompt({
      taskPrompt: "Create the requested file.",
      workspacePath: "/tmp/neoworker-task",
      contextNotes: ["Plan note", "Plan note"],
      appliedSkillContext: "ACTIVE SKILL: documents",
      deliverableContract:
        "Create a valid .pdf artifact before the final response.",
    });

    expect(prompt).toContain("<neoworker_runtime_contract_v1>");
    expect(prompt).toContain("read-only background data");
    expect(prompt).toContain("Use tools silently while working");
    expect(prompt).toContain("Only the final response");
    expect(prompt).toContain("Store intermediate chunk drafts");
    expect(prompt).toContain("Do not create process files such as");
    expect(prompt).toContain("<neoworker_workspace_v1>");
    expect(prompt).toContain("Workspace root: /tmp/neoworker-task");
    expect(prompt).toContain("<neoworker_task_v1>");
    expect(prompt).toContain("<neoworker_context_v1>");
    expect(prompt.match(/Plan note/g)).toHaveLength(1);
    expect(prompt).toContain("<neoworker_skills_v1>");
    expect(prompt).toContain("<neoworker_deliverable_contract_v1>");
    expect(prompt).toContain("Create a valid .pdf artifact");
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
    expect(prompt).toContain("return only the concise final answer");
    expect(prompt).not.toContain("<neoworker_task_v1>");
  });

  it("uses a recovery prompt that explicitly protects unknown side effects", () => {
    const prompt = buildHermesRecoveryPrompt({
      taskPrompt: "Build the project.",
      workspacePath: "/tmp/workspace",
      appliedSkillContext: "ACTIVE SKILL: documents\nUse the document workflow.",
      deliverableContract: "Create the requested .pdf file before completion.",
    });

    expect(prompt).toContain("<neoworker_recovery_v1>");
    expect(prompt).toContain("saved Hermes checkpoint");
    expect(prompt).toContain("unknown");
    expect(prompt).toContain("<neoworker_skills_v1>");
    expect(prompt).toContain("Use the document workflow.");
    expect(prompt).toContain("<neoworker_deliverable_contract_v1>");
    expect(prompt).toContain("Create the requested .pdf file");
  });

  it("preserves the configured truncation marker", () => {
    expect(_testUtils.clampText("123456789", 5)).toContain("[NeoWorker context truncated]");
  });
});
