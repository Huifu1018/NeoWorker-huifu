import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveHermesHostLauncher, resolveHermesPythonCommand } from "../hermes-host-launcher";

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })); });

describe("Hermes host launcher resolution", () => {
  it("finds the shipped source launcher", () => {
    const launch = resolveHermesHostLauncher();
    expect(path.basename(launch.args[0]!)).toBe("hermes-acp-neoworker-host.py");
    expect(fs.existsSync(launch.args[0]!)).toBe(true);
  });

  it("preserves an explicitly configured Python path including spaces", () => {
    expect(resolveHermesPythonCommand({ NEOWORKER_HERMES_PYTHON: "C:\\Hermes Env\\python.exe" }, "win32"))
      .toBe("C:\\Hermes Env\\python.exe");
  });

  it.skipIf(process.platform === "win32")("uses the interpreter from Hermes' shebang", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-launcher-"));
    directories.push(dir);
    const python = path.join(dir, "python3");
    fs.writeFileSync(python, "");
    fs.writeFileSync(path.join(dir, "hermes"), `#!${python}\n`);
    expect(resolveHermesPythonCommand({ PATH: dir }, "darwin")).toBe(python);
  });
});
