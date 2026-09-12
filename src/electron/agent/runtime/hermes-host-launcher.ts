import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LAUNCHER_FILENAME = "hermes-acp-neoworker-host.py";
const HERMES_HOST_BINARY_BASENAME = "hermes-acp-neoworker-host";
const HERMES_EXECUTABLE = "hermes";

function readUnixShebangInterpreter(executable: string): string | undefined {
  try {
    const fd = fs.openSync(executable, "r");
    const prefix = Buffer.alloc(1024);
    let length = 0;
    try {
      length = fs.readSync(fd, prefix, 0, prefix.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const firstLine = prefix.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0] || "";
    const interpreter = firstLine.match(/^#!\s*(\/[^\s]+python[^\s]*)\s*$/)?.[1];
    return interpreter && fs.existsSync(interpreter) ? interpreter : undefined;
  } catch {
    return undefined;
  }
}

function resolvePythonBesideHermes(
  executable: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "win32") {
    const pathApi = path.win32;
    const normalizedEntry = pathApi.dirname(executable);
    for (const candidate of [
      pathApi.join(normalizedEntry, "python.exe"),
      pathApi.join(normalizedEntry, "..", "python.exe"),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  return readUnixShebangInterpreter(executable);
}

function commonHermesExecutableCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") return [];
  const home = env.HOME?.trim() || os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", HERMES_EXECUTABLE),
    path.join(home, ".pyenv", "shims", HERMES_EXECUTABLE),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
    "/Library/Frameworks/Python.framework/Versions/Current/bin/hermes",
  ];

  // Python.org installers place pip entry points under a versioned framework
  // directory. Finder-launched apps do not inherit the shell PATH, so inspect
  // those directories explicitly before falling back to system python3.
  const frameworkVersions = "/Library/Frameworks/Python.framework/Versions";
  try {
    for (const version of fs.readdirSync(frameworkVersions).sort().reverse()) {
      candidates.push(path.join(frameworkVersions, version, "bin", HERMES_EXECUTABLE));
    }
  } catch {
    // The framework is optional on non-macOS systems.
  }

  return candidates;
}

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
      const interpreter = resolvePythonBesideHermes(executable, platform);
      if (interpreter) return interpreter;
    }
  }

  for (const executable of commonHermesExecutableCandidates(env, platform)) {
    if (!fs.existsSync(executable)) continue;
    const interpreter = resolvePythonBesideHermes(executable, platform);
    if (interpreter) return interpreter;
  }

  return platform === "win32" ? "python" : "python3";
}

function hermesHostBinaryFilename(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `${HERMES_HOST_BINARY_BASENAME}.exe`
    : HERMES_HOST_BINARY_BASENAME;
}

function isPackagedElectronApp(resourcesPath: string | undefined): boolean {
  // electron-builder's packaged app always has app.asar beside extraResources.
  // In development, Electron uses default_app.asar instead, so source-mode
  // fallback remains available for local adapter development.
  return Boolean(resourcesPath && fs.existsSync(path.join(resourcesPath, "app.asar")));
}

export function resolveHermesHostLauncher(): { command: string; args: string[] } {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const binaryFilename = hermesHostBinaryFilename(process.platform);
  const binaryCandidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "hermes-runtime", binaryFilename)] : []),
    path.resolve(__dirname, "../../../../build/hermes-runtime", binaryFilename),
    path.resolve(__dirname, "../../../../../build/hermes-runtime", binaryFilename),
  ];
  const binary = binaryCandidates.find((candidate) => fs.existsSync(candidate));
  if (binary) return { command: binary, args: [] };

  if (isPackagedElectronApp(resourcesPath)) {
    throw new Error(
      `NeoWorker's bundled Hermes runtime is missing from ${path.join(
        resourcesPath!,
        "hermes-runtime",
      )}. Reinstall NeoWorker instead of installing Hermes separately.`,
    );
  }

  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "hermes-runtime", LAUNCHER_FILENAME)] : []),
    path.resolve(__dirname, "../../../../scripts", LAUNCHER_FILENAME),
    path.resolve(__dirname, "../../../../../scripts", LAUNCHER_FILENAME),
  ];
  const launcher = candidates.find((candidate) => fs.existsSync(candidate));
  if (!launcher) throw new Error("NeoWorker's Hermes host launcher is missing from this installation");
  return { command: resolveHermesPythonCommand(), args: [launcher] };
}
