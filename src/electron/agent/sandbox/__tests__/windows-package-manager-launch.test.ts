import { describe, expect, it } from "vitest";
import { resolveWindowsPackageManagerLaunch } from "../windows-package-manager-launch";

describe("Windows package manager direct launch", () => {
  it("translates npm.cmd to node.exe plus npm-cli.js", () => {
    const seen: string[] = [];
    const result = resolveWindowsPackageManagerLaunch(
      "npm.cmd",
      ["install", "--ignore-scripts"],
      "C:\\workspace",
      { PATH: "C:\\Users\\dev\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs" },
      (candidate) => {
        seen.push(candidate);
        return candidate === "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js" ||
          candidate === "C:\\Program Files\\nodejs\\node.exe";
      },
    );

    expect(result).toEqual({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js",
        "install",
        "--ignore-scripts",
      ],
    });
    expect(seen).not.toContain("C:\\workspace\\npm.cmd");
  });

  it("preserves non-package executables and argv", () => {
    const args = ["C:\\work space\\script.py"];
    expect(resolveWindowsPackageManagerLaunch("python.exe", args, "C:\\workspace", {})).toEqual({
      executable: "python.exe",
      args,
    });
  });

  it("fails clearly when npm's CLI or node runtime is missing", () => {
    expect(() => resolveWindowsPackageManagerLaunch(
      "npx.cmd",
      ["--yes", "prettier", "."],
      "C:\\workspace",
      { Path: "C:\\tools" },
      () => false,
    )).toThrow("Windows npx CLI was not found");
  });
});
