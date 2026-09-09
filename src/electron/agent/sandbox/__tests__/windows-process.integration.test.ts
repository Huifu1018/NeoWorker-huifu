import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WindowsRestrictedSandbox } from "../sandbox-factory";

// No process/platform mocks: these assertions must run on the Windows runner.
describe.skipIf(process.platform !== "win32")("Windows real process execution", () => {
  let workspace: string;
  let sandbox: WindowsRestrictedSandbox;
  const cleanupPids: number[] = [];

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "neoworker 中文 space-"));
    sandbox = new WindowsRestrictedSandbox({
      id: "windows-process-integration",
      name: "Windows process integration",
      path: workspace,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, shell: true, network: false },
    });
  });

  afterEach(async () => {
    for (const pid of cleanupPids.splice(0)) {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore", timeout: 3_000, windowsHide: true,
        });
      } catch { /* The assertion normally already proved the process exited. */ }
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("round-trips cwd, Chinese output, argv and task-scoped environment", async () => {
    const script = path.join(workspace, "检查 script.cjs");
    await writeFile(script, `process.stdout.write(JSON.stringify({
      cwd: process.cwd(), arg: process.argv[2], value: process.env.NEOWORKER_TEST_VALUE,
      text: '中文输出 😀'
    }));`, "utf8");

    const result = await sandbox.execute(process.execPath, [script, "含有 spaces 的参数"], {
      cwd: workspace, timeout: 5_000, env: { NEOWORKER_TEST_VALUE: "任务变量" },
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: workspace, arg: "含有 spaces 的参数", value: "任务变量", text: "中文输出 😀",
    });
  });

  it("preserves a non-zero exit and can execute the next command", async () => {
    const script = path.join(workspace, "fail.cjs");
    await writeFile(script, "process.stderr.write('expected failure'); process.exitCode = 17;");
    expect(await sandbox.execute(process.execPath, [script], { timeout: 5_000 }))
      .toMatchObject({ exitCode: 17, stderr: "expected failure", timedOut: false });
    expect(await sandbox.execute("echo recovered"))
      .toMatchObject({ exitCode: 0, stdout: "recovered\n" });
  });

  it("installs a local dependency offline through the real npm wrapper", async () => {
    const dependency = path.join(workspace, "local package");
    await mkdir(dependency);
    await writeFile(path.join(dependency, "package.json"), JSON.stringify({
      name: "neoworker-offline-fixture", version: "1.0.0", main: "index.cjs",
    }));
    await writeFile(path.join(dependency, "index.cjs"), "module.exports = 'installed 中文';");
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "neoworker-install-test", version: "1.0.0", private: true,
    }));
    const install = await sandbox.execute("npm", [
      "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "./local package",
    ], { timeout: 30_000 });
    expect(install, install.stderr).toMatchObject({ exitCode: 0, timedOut: false });
    const script = path.join(workspace, "verify.cjs");
    await writeFile(script, "process.stdout.write(require('neoworker-offline-fixture'));");
    expect(await sandbox.execute(process.execPath, [script], { timeout: 5_000 }))
      .toMatchObject({ exitCode: 0, stdout: "installed 中文" });
  }, 40_000);

  it("terminates parent and child on timeout and recovers in the same cwd", async () => {
    const worker = path.join(workspace, "worker.cjs");
    const parent = path.join(workspace, "parent.cjs");
    const pidFile = path.join(workspace, "child.pid");
    await writeFile(worker, "process.stdin.resume(); setInterval(() => {}, 100);");
    await writeFile(parent, `
      const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: 'inherit' });
      child.once('spawn', () => require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)));
      process.stdin.resume(); setInterval(() => {}, 100);
    `);
    const result = await sandbox.execute(process.execPath, [parent], {
      cwd: workspace, timeout: 3_000,
      onProcess: (child) => { if (child.pid) cleanupPids.push(child.pid); },
    });
    const workerPid = Number(await readFile(pidFile, "utf8"));
    cleanupPids.push(workerPid);
    expect(result).toMatchObject({ timedOut: true, killed: true, error: "PROCESS_TIMEOUT" });
    for (const pid of cleanupPids) {
      expect(() => process.kill(pid, 0), `PID ${pid} should have exited`).toThrow();
    }
    expect(await sandbox.execute("pwd", [], { cwd: workspace }))
      .toMatchObject({ exitCode: 0, stdout: `${workspace}\n` });
  }, 15_000);
});
