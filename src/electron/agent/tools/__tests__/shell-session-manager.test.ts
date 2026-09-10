import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { _testUtils } from "../shell-session-manager";
import { ShellSessionManager } from "../shell-session-manager";

describe("shell-session-manager", () => {
  it("does not use interactive shell startup on Unix sessions", () => {
    if (process.platform === "win32") {
      expect(_testUtils.getShellArgs("powershell.exe")).toEqual(["-NoLogo", "-NoProfile"]);
      expect(_testUtils.getTerminalShellArgs("C:\\Windows\\System32\\cmd.exe")).toEqual(["/Q"]);
      return;
    }

    expect(_testUtils.getShellArgs("/bin/zsh")).toEqual([]);
    expect(_testUtils.getTerminalShellArgs("/bin/zsh")).toEqual([]);
  });

  it("clears the active run marker when cancellation races with initial dispatch", async () => {
    const manager = Object.create(ShellSessionManager.prototype) as any;
    manager.sessions = new Map();
    manager.activeSessionRuns = new Set();
    manager.stateLoaded = true;

    const controller = new AbortController();
    const fakeProcess = {
      pid: undefined,
      stdin: { write: vi.fn() },
      stdout: {},
    } as unknown as ChildProcess;
    manager.spawnProcess = vi.fn((runtime: any) => {
      runtime.process = fakeProcess;
    });
    let persistCount = 0;
    manager.persistState = vi.fn(async () => {
      persistCount += 1;
      if (persistCount === 1) controller.abort();
    });

    await expect(
      manager.runCommand({
        taskId: "task-cancel-race",
        workspaceId: "workspace-cancel-race",
        workspacePath: process.cwd(),
        command: "echo should-not-dispatch",
        timeoutMs: 1_000,
        signal: controller.signal,
        fallbackRunner: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "AbortError", code: "CANCELLED" });

    expect(manager.activeSessionRuns.size).toBe(0);
    expect(fakeProcess.stdin.write).not.toHaveBeenCalled();
  });
});
