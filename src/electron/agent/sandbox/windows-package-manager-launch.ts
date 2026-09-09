import { existsSync } from "fs";
import { win32 as path } from "path";

export interface WindowsDirectLaunch {
  executable: string;
  args: string[];
}

/**
 * npm and npx ship as .cmd wrappers on Windows. Those wrappers cannot be
 * launched with shell:false. Invoke the matching CLI with node.exe instead,
 * keeping argv intact and the restricted runner free of a cmd.exe fallback.
 * Never use process.execPath here: in a packaged app that is Electron.
 */
export function resolveWindowsPackageManagerLaunch(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  probe: (candidate: string) => boolean = existsSync,
): WindowsDirectLaunch {
  const match = /^(npm|npx)(?:\.cmd|\.bat)?$/i.exec(path.basename(executable));
  if (!match) return { executable, args };

  const manager = match[1].toLowerCase();
  const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  const pathEntries = searchPath.split(";").map((entry) => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const explicitPath = /[\\/]/.test(executable);
  const explicitWrapper = /\.(?:cmd|bat)$/i.test(executable);
  const directories = explicitPath ? [path.dirname(path.resolve(cwd, executable))] : pathEntries;

  for (const directory of directories) {
    // A native package-manager executable needs no wrapper translation.
    if (!explicitWrapper) {
      const nativeExecutable = path.join(directory, `${manager}.exe`);
      if (probe(nativeExecutable)) return { executable: nativeExecutable, args };
    }
    const cli = path.join(directory, "node_modules", "npm", "bin", `${manager}-cli.js`);
    if (probe(cli)) {
      const node = [directory, ...pathEntries]
        .map((entry) => path.join(entry, "node.exe"))
        .find(probe);
      if (!node) throw new Error(`Windows ${manager} requires node.exe on PATH or next to its CLI.`);
      return { executable: node, args: [cli, ...args] };
    }
    // Do not silently select a different npm version after finding a broken
    // wrapper earlier on PATH, or substitute another install for an explicit path.
    if (explicitPath || probe(path.join(directory, `${manager}.cmd`)) || probe(path.join(directory, `${manager}.bat`))) break;
  }

  throw new Error(`Windows ${manager} CLI was not found. Install Node.js with npm and ensure its directory is on PATH.`);
}
