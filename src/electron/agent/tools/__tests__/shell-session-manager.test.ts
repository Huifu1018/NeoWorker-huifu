import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { _testUtils } from "../shell-session-manager";
import { ShellSessionManager } from "../shell-session-manager";

describe("shell-session-manager", () => {
  it("does not use interactive shell startup on Unix sessions", () => {
    if (process.platform === "win32") {
      expect(_testUtils.getShellArgs("powershell.exe")).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringContaining("[Console]::In.ReadLine()"),
      ]);
      expect(_testUtils.getTerminalShellArgs("C:\\Windows\\System32\\cmd.exe")).toEqual(["/Q"]);
      return;
    }

    expect(_testUtils.getShellArgs("/bin/zsh")).toEqual([]);
    expect(_testUtils.getTerminalShellArgs("/bin/zsh")).toEqual([]);
  });

  it("uses PowerShell syntax for Windows persistent commands", () => {
    const wrapper = _testUtils.buildCommandWrapper(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\workspace\\中文目录",
      "Write-Output '中文'; exit 7",
      "task-1:1",
      "win32",
    );
    expect(wrapper).toContain("[System.Convert]::FromBase64String(");
    expect(wrapper).toContain("Set-Location -LiteralPath 'C:\\workspace\\中文目录'");
    expect(wrapper).toContain("__NEOWORKER_DONE__:task-1:1:");
    expect(wrapper).not.toContain("set +e");
    expect(wrapper).not.toContain("eval \"$__neoworker_command\"");
  });

  it("uses cmd syntax when PowerShell is unavailable", () => {
    const wrapper = _testUtils.buildCommandWrapper(
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\workspace files",
      "echo one && echo two",
      "task-1:2",
      "win32",
    );
    expect(wrapper).toContain("@echo off");
    expect(wrapper).toContain('cd /d "C:\\workspace files"');
    expect(wrapper).toContain("echo __NEOWORKER_DONE__:task-1:2:%__NEOWORKER_EXIT%");
    expect(wrapper).not.toContain("printf");
  });

  it("rehydrates Windows cwd and environment without Unix export syntax", () => {
    const snapshot = {
      cwd: "C:\\workspace",
      env: { NEOWORKER_TEST: "中文" },
      aliases: {},
    };
    expect(_testUtils.buildRehydrateCommands(snapshot, "powershell.exe", "win32")).toEqual([
      "Set-Location -LiteralPath 'C:\\workspace'",
      "$env:NEOWORKER_TEST = '中文'",
    ]);
    expect(_testUtils.buildRehydrateCommands(snapshot, "cmd.exe", "win32")).toEqual([
      'cd /d "C:\\workspace"',
      'set "NEOWORKER_TEST=中文"',
    ]);
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
