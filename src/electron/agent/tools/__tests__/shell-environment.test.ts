import { describe, expect, it, vi, afterEach } from "vitest";
import { ShellTools } from "../shell-tools";
import { DockerSandbox } from "../../sandbox/docker-sandbox";
import { createSandbox, detectAvailableSandbox } from "../../sandbox/sandbox-factory";

vi.mock("../../sandbox/sandbox-factory", async (original) => ({
  ...await original<typeof import("../../sandbox/sandbox-factory")>(),
  detectAvailableSandbox: vi.fn(),
  createSandbox: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe("command environment guidance", () => {
  const workspace = { path: "/tmp/environment-fixture", permissions: { read: true, write: true } };

  it("separates a Windows host from the Linux Docker environment", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(detectAvailableSandbox).mockResolvedValue("docker");
    const tools = Object.create(ShellTools.prototype) as Any;
    tools.workspace = workspace;
    const result = await tools.environmentInfo();
    expect(result).toMatchObject({ hostPlatform: "win32", executionPlatform: "linux", shell: "/bin/sh", workspace: "/workspace" });
    expect(result.guidance).toContain("not Python/curl/PowerShell");
  });

  it("describes the no-Docker runner without pretending it is OS isolation", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(detectAvailableSandbox).mockResolvedValue("windows-restricted");
    const tools = Object.create(ShellTools.prototype) as Any;
    tools.workspace = workspace;
    const result = await tools.environmentInfo();
    expect(result).toMatchObject({ executionPlatform: "win32", shell: null });
    expect(result.guidance).toContain("NOT OS-level isolation");
    expect(result.guidance).toContain("native file/HTTP/Office tools");
  });

  it("provides writable package caches without weakening Docker isolation", () => {
    const sandbox = new DockerSandbox(workspace as Any) as Any;
    const args = sandbox.buildDockerArgs({ allowNetwork: false });
    for (const arg of ["HOME=/tmp", "NPM_CONFIG_CACHE=/tmp/.npm", "PIP_CACHE_DIR=/tmp/.pip", "--read-only", "no-new-privileges:true", "ALL", "/tmp:rw,noexec,nosuid,size=100m"]) expect(args).toContain(arg);
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });

  it("avoids immediately repeating missing executables and retries after a successful repair", async () => {
    const ok = { exitCode: 0, stdout: "ok", stderr: "", killed: false, timedOut: false };
    const sandbox = { type: "docker", cleanup: vi.fn(), initialize: vi.fn(), executeCode: vi.fn(), execute: vi.fn()
      .mockResolvedValueOnce({ ...ok, exitCode: 127, stderr: "/bin/sh: python3: not found" })
      .mockResolvedValue(ok) };
    vi.mocked(createSandbox).mockResolvedValue(sandbox as Any);
    const daemon = { logEvent: vi.fn() };
    const tools = new ShellTools(workspace as Any, daemon as Any, "environment-test") as Any;
    const options = { cwd: workspace.path, timeout: 1000, promptPrefix: "$ ", policies: { runtime: { allowedSandboxTypes: ["docker"] } } };
    expect(await tools.runCommandInSandbox("python3 script.py", options)).toMatchObject({ exitCode: 127 });
    expect(await tools.runCommandInSandbox("python3 script.py", options)).toMatchObject({ error: "EXECUTABLE_UNAVAILABLE" });
    expect(sandbox.execute).toHaveBeenCalledTimes(1);
    await tools.runCommandInSandbox("repair-dependency", options);
    expect(await tools.runCommandInSandbox("python3 script.py", options)).toMatchObject({ success: true });
    expect(sandbox.execute).toHaveBeenCalledTimes(3);
    expect(sandbox.cleanup).toHaveBeenCalledTimes(4);
    expect(daemon.logEvent).toHaveBeenCalledWith("environment-test", "command_output", expect.objectContaining({ type: "end", durationMs: expect.any(Number) }));
  });
});
