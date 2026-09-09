import { EventEmitter } from "events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

import {
  isMacOSSandboxAvailable,
  resetMacOSSandboxCache,
  WindowsRestrictedSandbox,
} from "../sandbox-factory";

function makeChildProcess(options: {
  closeCode?: number | null;
  closeSignal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
  stayOpen?: boolean;
  pid?: number;
} = {}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as ChildProcess["stdout"];
  proc.stderr = new EventEmitter() as ChildProcess["stderr"];
  proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  if (options.pid !== undefined) {
    Object.defineProperty(proc, "pid", { value: options.pid, configurable: true });
  }
  if (!options.stayOpen) {
    queueMicrotask(() => {
      if (options.stdout) proc.stdout?.emit("data", Buffer.from(options.stdout));
      if (options.stderr) proc.stderr?.emit("data", Buffer.from(options.stderr));
      if (options.errorMessage) {
        proc.emit("error", new Error(options.errorMessage));
        return;
      }
      proc.emit(
        "close",
        options.closeCode === undefined ? 0 : options.closeCode,
        options.closeSignal ?? null,
      );
    });
  }
  return proc;
}

describe("sandbox factory macOS probe", () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMacOSSandboxCache();
    spawnMock.mockReset();
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterEach(() => {
    resetMacOSSandboxCache();
    platformSpy.mockRestore();
    vi.useRealTimers();
  });

  it("reports macOS sandbox-exec available after a successful probe", async () => {
    spawnMock.mockReturnValueOnce(makeChildProcess({ closeCode: 0, stdout: "ok\n" }));

    await expect(isMacOSSandboxAvailable()).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledWith(
      "sandbox-exec",
      ["-f", expect.any(String), "/bin/echo", "ok"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("reports macOS sandbox-exec unavailable when the strict probe is aborted", async () => {
    spawnMock.mockReturnValueOnce(
      makeChildProcess({ closeCode: null, closeSignal: "SIGABRT" }),
    );

    await expect(isMacOSSandboxAvailable()).resolves.toBe(false);
  });

  it("reports macOS sandbox-exec unavailable when sandbox_apply fails", async () => {
    spawnMock.mockReturnValueOnce(
      makeChildProcess({ closeCode: 134, stderr: "sandbox_apply: Operation not permitted\n" }),
    );

    await expect(isMacOSSandboxAvailable()).resolves.toBe(false);
  });

  it("reports macOS sandbox-exec unavailable after spawn errors", async () => {
    spawnMock.mockReturnValueOnce(makeChildProcess({ errorMessage: "spawn sandbox-exec ENOENT" }));

    await expect(isMacOSSandboxAvailable()).resolves.toBe(false);
  });

  it("reports macOS sandbox-exec unavailable after probe timeout", async () => {
    vi.useFakeTimers();
    const proc = makeChildProcess({ stayOpen: true });
    spawnMock.mockReturnValueOnce(proc);

    const available = isMacOSSandboxAvailable();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(available).resolves.toBe(false);
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe("Windows restricted runner", () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    platformSpy.mockRestore();
  });

  it("rejects shell operators instead of invoking cmd.exe", async () => {
    const sandbox = new WindowsRestrictedSandbox({
      id: "workspace",
      name: "Workspace",
      path: "/tmp/workspace",
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: true },
    });

    await expect(sandbox.execute("python script.py & whoami", [], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      error: "WINDOWS_RESTRICTED_SHELL_SYNTAX",
      exitCode: 1,
    });
  });

  it("rejects nested PowerShell and inline code execution", async () => {
    const sandbox = new WindowsRestrictedSandbox({
      id: "workspace",
      name: "Workspace",
      path: "/tmp/workspace",
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: true },
    });

    await expect(sandbox.execute("powershell.exe -Command whoami", [], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      error: "WINDOWS_RESTRICTED_NESTED_SHELL",
      exitCode: 1,
    });
    await expect(sandbox.execute("python -c print(1)", [], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      error: "WINDOWS_RESTRICTED_INLINE_CODE",
      exitCode: 1,
    });
  });

  it("runs workspace compatibility builtins without starting a shell", async () => {
    const sandbox = new WindowsRestrictedSandbox({
      id: "workspace",
      name: "Workspace",
      path: "/tmp/workspace",
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: true },
    });

    await expect(sandbox.execute("pwd", [], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/tmp/workspace\n",
    });
    await expect(sandbox.execute("echo validation", [], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "validation\n",
    });
    await expect(sandbox.execute("echo one && echo two", [], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "one\ntwo\n",
    });
    await expect(sandbox.execute("cat missing.txt || echo fallback", [], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "fallback\n",
    });
  });

  it("preserves direct-process argv entries containing spaces", async () => {
    spawnMock.mockImplementationOnce(() => makeChildProcess({ stdout: "ok\n" }));
    const sandbox = new WindowsRestrictedSandbox({
      id: "workspace",
      name: "Workspace",
      path: "/tmp/workspace",
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: true },
    });

    await expect(sandbox.execute("python", ["workspace files\\script.py"], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "python",
      ["workspace files\\script.py"],
      expect.objectContaining({ shell: false, cwd: "/tmp/workspace" }),
    );
  });

  it("passes only explicitly requested environment variables", async () => {
    const previous = process.env.NEOWORKER_TEST_ENV;
    process.env.NEOWORKER_TEST_ENV = "hermes-proxy";
    spawnMock.mockImplementationOnce(() => makeChildProcess({ stdout: "ok\n" }));
    try {
      const sandbox = new WindowsRestrictedSandbox({
        id: "workspace",
        name: "Workspace",
        path: "/tmp/workspace",
        createdAt: Date.now(),
        permissions: { read: true, write: true, delete: true, network: false, shell: true },
      });
      await expect(sandbox.execute("python", ["script.py"], {
        cwd: "/tmp/workspace",
        envPassthrough: ["NEOWORKER_TEST_ENV", "bad-name"],
      })).resolves.toMatchObject({ exitCode: 0 });
      expect(spawnMock).toHaveBeenCalledWith(
        "python",
        ["script.py"],
        expect.objectContaining({
          env: expect.objectContaining({ NEOWORKER_TEST_ENV: "hermes-proxy" }),
        }),
      );
      const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as { env?: Record<string, string> };
      expect(spawnOptions.env).not.toHaveProperty("bad-name");
    } finally {
      if (previous === undefined) delete process.env.NEOWORKER_TEST_ENV;
      else process.env.NEOWORKER_TEST_ENV = previous;
    }
  });

  it("passes task-scoped environment values without allowing protected overrides", async () => {
    spawnMock.mockImplementationOnce(() => makeChildProcess({ stdout: "ok\n" }));
    const sandbox = new WindowsRestrictedSandbox({
      id: "workspace",
      name: "Workspace",
      path: "/tmp/workspace",
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: true },
    });

    await expect(sandbox.execute("python", ["script.py"], {
      cwd: "/tmp/workspace",
      env: {
        NEO_WORKER_MODE: "hermes-proxy",
        PATH: "C:\\attacker",
        "bad-name": "ignored",
      },
    })).resolves.toMatchObject({ exitCode: 0 });

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env).toMatchObject({ NEO_WORKER_MODE: "hermes-proxy" });
    expect(spawnOptions.env?.PATH).not.toBe("C:\\attacker");
    expect(spawnOptions.env).not.toHaveProperty("bad-name");
  });

  it("decodes common Windows code-page output when UTF-8 is invalid", async () => {
    const sandbox = new WindowsRestrictedSandbox({
      id: "workspace",
      name: "Workspace",
      path: "/tmp/workspace",
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: true },
    });
    spawnMock.mockImplementationOnce(() => {
      const process = makeChildProcess({ stayOpen: true });
      queueMicrotask(() => process.stdout?.emit("data", Buffer.from([0xd6, 0xd0])));
      queueMicrotask(() => process.emit("close", 0, null));
      return process;
    });
    await expect(sandbox.execute("python", ["script.py"], { cwd: "/tmp/workspace" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "中",
    });
  });

  it("terminates the Windows process tree when a direct command times out", async () => {
    vi.useFakeTimers();
    const child = makeChildProcess({ stayOpen: true, pid: 4321 });
    spawnMock.mockReturnValueOnce(child);
    const sandbox = new WindowsRestrictedSandbox({
      id: "workspace",
      name: "Workspace",
      path: "/tmp/workspace",
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: true },
    });
    const resultPromise = sandbox.execute("python", ["script.py"], {
      cwd: "/tmp/workspace",
      timeout: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(child.kill).toHaveBeenCalled();
    child.emit("close", null, "SIGTERM");
    await expect(resultPromise).resolves.toMatchObject({ timedOut: true, killed: true });
  });
});
