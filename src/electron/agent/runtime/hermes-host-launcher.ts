import * as fs from "node:fs";
import * as path from "node:path";

const LAUNCHER_FILENAME = "hermes-acp-neoworker-host.py";

/** Resolve the Python that owns `hermes`, preserving virtualenv installs. */
export function resolveHermesPythonCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.NEOWORKER_HERMES_PYTHON?.trim();
  if (configured) return configured;
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? ["hermes.exe", "hermes.cmd", "hermes"] : ["hermes"];
  for (const entry of pathValue.split(platform === "win32" ? ";" : ":")) {
    const normalizedEntry = entry.trim().replace(/^"|"$/g, "");
    if (!normalizedEntry) continue;
    for (const name of names) {
      const executable = pathApi.join(normalizedEntry, name);
      if (!fs.existsSync(executable)) continue;
      if (platform === "win32") {
        // venvs keep Python in Scripts; a system install keeps it one level
        // above Scripts. Use that interpreter instead of a different PATH one.
        for (const candidate of [
          pathApi.join(normalizedEntry, "python.exe"),
          pathApi.join(normalizedEntry, "..", "python.exe"),
        ]) {
          if (fs.existsSync(candidate)) return candidate;
        }
      } else {
        try {
          const fd = fs.openSync(executable, "r");
          const prefix = Buffer.alloc(1024);
          let length: number;
          try { length = fs.readSync(fd, prefix, 0, prefix.length, 0); }
          finally { fs.closeSync(fd); }
          const firstLine = prefix.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0] || "";
          const interpreter = firstLine.match(/^#!\s*(\/[^\s]+python[^\s]*)\s*$/)?.[1];
          if (interpreter && fs.existsSync(interpreter)) return interpreter;
        } catch { /* Fall back to the active Python on PATH. */ }
      }
    }
  }
  return platform === "win32" ? "python" : "python3";
}

export function resolveHermesHostLauncher(): { command: string; args: string[] } {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "hermes-runtime", LAUNCHER_FILENAME)] : []),
    path.resolve(__dirname, "../../../../scripts", LAUNCHER_FILENAME),
    path.resolve(__dirname, "../../../../../scripts", LAUNCHER_FILENAME),
  ];
  const launcher = candidates.find((candidate) => fs.existsSync(candidate));
  if (!launcher) throw new Error("NeoWorker's Hermes host launcher is missing from this installation");
  return { command: resolveHermesPythonCommand(), args: [launcher] };
}
