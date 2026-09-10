import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ShellSessionManager } from "../shell-session-manager";

/**
 * These assertions run on the Windows CI runner because macOS/Linux do not
 * provide the PowerShell/cmd process semantics under test.
 */
describe.skipIf(process.platform !== "win32")("Windows persistent shell session", () => {
  let workspace: string;
  let manager: ShellSessionManager;
  let taskId: string;
  let workspaceId: string;

  const removeWorkspaceEventually = async (directory: string): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        return;
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (lastError && process.platform === "win32") {
      try {
        console.error(
          "[windows-shell-session:cleanup-processes]",
          execFileSync(
            "tasklist",
            ["/FI", "IMAGENAME eq pwsh.exe", "/FO", "CSV", "/NH"],
            { encoding: "utf8" },
          ),
        );
        console.error(
          "[windows-shell-session:cleanup-cmd-processes]",
          execFileSync(
            "tasklist",
            ["/FI", "IMAGENAME eq cmd.exe", "/FO", "CSV", "/NH"],
            { encoding: "utf8" },
          ),
        );
      } catch {
        // Best effort diagnostics only.
      }
    }
    if (lastError) throw lastError;
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "neoworker-shell-session-"));
    manager = ShellSessionManager.getInstance();
    taskId = `windows-shell-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    workspaceId = `workspace-${taskId}`;
  });

  afterEach(async () => {
    await manager.closeSession(taskId, workspaceId);
    await removeWorkspaceEventually(workspace);
  });

  it("executes UTF-8 PowerShell commands and preserves session environment", async () => {
    const first = await manager.runCommand({
      taskId,
      workspaceId,
      workspacePath: workspace,
      command: "$env:NEOWORKER_TEST_VALUE = '任务变量'; Write-Output '中文输出 😀'",
      timeoutMs: 5_000,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "fallback should not run",
        exitCode: null,
        terminationReason: "error",
        truncated: false,
      }),
    });
    expect(first).toMatchObject({
      success: true,
      exitCode: 0,
      usedPersistentSession: true,
    });
    expect(first.stdout).toContain("中文输出 😀");

    const second = await manager.runCommand({
      taskId,
      workspaceId,
      workspacePath: workspace,
      command: "Write-Output $env:NEOWORKER_TEST_VALUE",
      timeoutMs: 5_000,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "fallback should not run",
        exitCode: null,
        terminationReason: "error",
        truncated: false,
      }),
    });
    expect(second).toMatchObject({ success: true, exitCode: 0 });
    expect(second.stdout).toContain("任务变量");
  }, 20_000);

  it("returns native exit codes and recovers after a timed-out process", async () => {
    const failed = await manager.runCommand({
      taskId,
      workspaceId,
      workspacePath: workspace,
      command: "cmd.exe /d /c exit 17",
      timeoutMs: 5_000,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "fallback should not run",
        exitCode: null,
        terminationReason: "error",
        truncated: false,
      }),
    });
    expect(failed).toMatchObject({ success: false, exitCode: 17, usedPersistentSession: true });

    await expect(manager.runCommand({
      taskId,
      workspaceId,
      workspacePath: workspace,
      command: "Start-Sleep -Seconds 30",
      timeoutMs: 1_500,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "fallback should not run",
        exitCode: null,
        terminationReason: "error",
        truncated: false,
      }),
    })).rejects.toThrow(/timed out/i);

    const recovered = await manager.runCommand({
      taskId,
      workspaceId,
      workspacePath: workspace,
      command: "Write-Output 'recovered'",
      timeoutMs: 5_000,
      fallbackRunner: async () => ({
        success: false,
        stdout: "",
        stderr: "fallback should not run",
        exitCode: null,
        terminationReason: "error",
        truncated: false,
      }),
    });
    expect(recovered).toMatchObject({ success: true, exitCode: 0 });
    expect(recovered.stdout).toContain("recovered");
  }, 20_000);
});
