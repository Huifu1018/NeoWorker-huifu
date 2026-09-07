import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  fileURLToPath(new URL("../App.tsx", import.meta.url)),
  "utf8",
);

describe("model switching inside an active session", () => {
  it("keeps model changes as a per-query override without rewriting the active task", () => {
    const handlerStart = appSource.indexOf("const handleModelChange = async");
    const handlerEnd = appSource.indexOf(
      "const handleDevRunLoggingEnabledChange",
      handlerStart,
    );
    const handlerSource = appSource.slice(handlerStart, handlerEnd);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerSource).toContain("setSelectedModel(modelKey)");
    expect(handlerSource).not.toContain("updateTaskModel");
    expect(handlerSource).not.toContain("setSelectedTaskId(null)");
    expect(handlerSource).not.toContain("setEvents([])");
    expect(handlerSource).not.toContain("clearRemoteTaskView()");
    expect(handlerSource).not.toContain('setCurrentView("main")');
  });

  it("restores the model stored on each selected task", () => {
    expect(appSource).toContain(
      "selectedTask?.agentConfig?.modelKey?.trim()",
    );
    expect(appSource).toContain("selectedTask?.agentConfig?.providerType");
    expect(appSource).toContain("setSelectedModel(modelKey)");
    expect(appSource).toContain("setSelectedProvider(providerType)");
  });

  it("snapshots the selected model when a new task is created", () => {
    const createStart = appSource.indexOf("const handleCreateTask");
    const createEnd = appSource.indexOf(
      "const handleSendMessage",
      createStart,
    );
    const createSource = appSource.slice(createStart, createEnd);

    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(createEnd).toBeGreaterThan(createStart);
    expect(createSource).toContain(
      "const trimmedSessionModelOverride = selectedModel.trim()",
    );
    expect(createSource).toContain("providerType: selectedProvider");
    expect(createSource).toContain(
      "modelKey: effectiveSessionModelOverride",
    );
  });
});
