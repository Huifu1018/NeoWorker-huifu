/**
 * Sandbox Factory
 *
 * Provides a unified interface for sandbox implementations and factory
 * function to create the appropriate sandbox based on platform and availability.
 *
 * Supports:
 * - macOS sandbox-exec (native, preferred on macOS)
 * - Docker containers (cross-platform)
 * - No sandbox (fallback)
 */

import { Workspace } from "../../../shared/types";
import { MacOSSandbox } from "./macos-sandbox";
import { DockerSandbox } from "./docker-sandbox";
import { spawn, type ChildProcess } from "child_process";
import * as os from "os";
import * as path from "path";
import { realpathSync } from "fs";
import { promises as fs } from "fs";
import { createSecureTempFile } from "./security-utils";
import { resolveWindowsPackageManagerLaunch } from "./windows-package-manager-launch";

/**
 * Sandbox type enumeration
 */
export type SandboxType = "macos" | "docker" | "windows-restricted" | "none";

/**
 * Sandbox execution options
 */
export interface SandboxOptions {
  /** Working directory for command execution */
  cwd?: string;
  /** Command execution timeout in milliseconds */
  timeout?: number;
  /** Maximum output size in bytes */
  maxOutputSize?: number;
  /** Allow network access */
  allowNetwork?: boolean;
  /** Additional allowed paths for read access */
  allowedReadPaths?: string[];
  /** Additional allowed paths for write access */
  allowedWritePaths?: string[];
  /** Environment variables to pass through */
  envPassthrough?: string[];
  /** Explicit task-scoped environment variables. Sensitive host variables are never inherited implicitly. */
  env?: Record<string, string>;
  /** Called with the backing process once the sandbox starts it. */
  onProcess?: (process: ChildProcess) => void;
}

/**
 * Sandbox execution result
 */
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  killed: boolean;
  timedOut: boolean;
  signal?: string | null;
  error?: string;
}

/**
 * Unified sandbox interface
 * All sandbox implementations must implement this interface
 */
export interface ISandbox {
  /** The type of sandbox implementation */
  readonly type: SandboxType;

  /**
   * Initialize the sandbox environment
   * Must be called before execute()
   */
  initialize(): Promise<void>;

  /**
   * Execute a command in the sandbox
   */
  execute(command: string, args?: string[], options?: SandboxOptions): Promise<SandboxResult>;

  /**
   * Execute code in the sandbox (Python or JavaScript)
   */
  executeCode(code: string, language: "python" | "javascript"): Promise<SandboxResult>;

  /**
   * Cleanup sandbox resources
   */
  cleanup(): void;
}

/**
 * No-op sandbox implementation for when sandboxing is unavailable
 * Still enforces timeouts and output limits, but no OS-level isolation
 */
export class NoSandbox implements ISandbox {
  readonly type: SandboxType = "none";
  protected workspace: Workspace;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  async initialize(): Promise<void> {
    // No initialization needed
  }

  async execute(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {},
  ): Promise<SandboxResult> {
    const timeout = options.timeout ?? 5 * 60 * 1000;
    const maxOutputSize = options.maxOutputSize ?? 100 * 1024;
    const cwd = options.cwd || this.workspace.path;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let timedOut = false;

      const shell =
        process.platform === "win32"
          ? process.env.COMSPEC || "cmd.exe"
          : "/bin/sh";
      const proc =
        args.length > 0
          ? spawn(command, args, {
              cwd,
              shell: false,
              stdio: ["pipe", "pipe", "pipe"],
            })
          : spawn(
              shell,
              process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
              {
                cwd,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
              },
            );
      options.onProcess?.(proc);

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killed = true;
        proc.kill("SIGKILL");
      }, timeout);

      proc.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length <= maxOutputSize) {
          stdout += chunk;
        } else if (stdout.length < maxOutputSize) {
          stdout += chunk.slice(0, maxOutputSize - stdout.length);
          stdout += "\n[Output truncated]";
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length + chunk.length <= maxOutputSize) {
          stderr += chunk;
        } else if (stderr.length < maxOutputSize) {
          stderr += chunk.slice(0, maxOutputSize - stderr.length);
          stderr += "\n[Output truncated]";
        }
      });

      proc.on("close", (code, signal) => {
        clearTimeout(timeoutHandle);
        const terminationError = signal ? `Process terminated by signal ${signal}` : undefined;
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr: stderr || terminationError || "",
          killed,
          timedOut,
          signal,
          error: terminationError,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          killed,
          timedOut,
          error: err.message,
        });
      });
    });
  }

  async executeCode(code: string, language: "python" | "javascript"): Promise<SandboxResult> {
    const ext = language === "python" ? ".py" : ".js";
    const { filePath, cleanup } = createSecureTempFile(ext, code);

    try {
      const interpreter = language === "python" ? "python3" : "node";
      return await this.execute(interpreter, [filePath], {
        timeout: 60 * 1000,
        allowNetwork: false,
      });
    } finally {
      cleanup();
    }
  }

  cleanup(): void {
    // No cleanup needed
  }
}

/**
 * Windows fallback for approved, workspace-scoped commands.
 *
 * Windows does not provide a sandbox-exec equivalent. This runner deliberately
 * does not invoke cmd.exe/PowerShell and rejects shell operators, so the
 * fallback is limited to a single executable plus arguments. Docker remains
 * preferred when available; this path exists so bundled workflows (Python
 * preflight and officecli.exe) work on a clean Windows installation without
 * requiring a global unsandboxed-shell override.
 */
export class WindowsRestrictedSandbox extends NoSandbox {
  readonly type: SandboxType = "windows-restricted";

  async execute(
    command: string,
    args: string[] = [],
    options: SandboxOptions = {},
  ): Promise<SandboxResult> {
    if (process.platform !== "win32") {
      return super.execute(command, args, options);
    }
    if (args.length === 0 && /[\r\n&|<>^]/.test(command)) {
      const sequence = parseWindowsRestrictedSequence(command);
      if (sequence) {
        return executeWindowsRestrictedSequence(this, sequence, options);
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Windows restricted runner rejected unsupported shell syntax. Use direct commands, &&/||/; sequencing, and workspace-local > redirection.",
        killed: false,
        timedOut: false,
        error: "WINDOWS_RESTRICTED_SHELL_SYNTAX",
      };
    }

    const timeout = options.timeout ?? 5 * 60 * 1000;
    const maxOutputSize = options.maxOutputSize ?? 100 * 1024;
    const cwd = options.cwd || this.workspacePath();
    const resolvedCwd = path.resolve(cwd);
    const workspaceRoot = path.resolve(this.workspacePath());
    if (!isPathWithinWorkspace(workspaceRoot, resolvedCwd)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Windows restricted runner only permits commands inside the active workspace.",
        killed: false,
        timedOut: false,
        error: "WINDOWS_RESTRICTED_CWD_OUTSIDE_WORKSPACE",
      };
    }

    // When callers already provide an argv array, preserve each argument as
    // one token. Re-joining and re-tokenizing would split valid Windows paths
    // such as "workspace files\\script.py" at their spaces.
    const tokens = args.length > 0
      ? [normalizeWindowsExecutable(command), ...args]
      : tokenizeDirectWindowsCommand(command);
    if (!tokens || tokens.length === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Windows restricted runner requires one executable and direct arguments.",
        killed: false,
        timedOut: false,
        error: "WINDOWS_RESTRICTED_INVALID_COMMAND",
      };
    }
    const executableToken = normalizeWindowsExecutable(tokens[0]);
    if (WINDOWS_SHELL_EXECUTABLES.has(executableToken.toLowerCase())) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Windows restricted runner does not invoke cmd.exe, PowerShell, or another shell.",
        killed: false,
        timedOut: false,
        error: "WINDOWS_RESTRICTED_NESTED_SHELL",
      };
    }
    const executable = executableToken.toLowerCase() === "python3" ? "python" : executableToken;
    const childArgs = tokens.slice(1);
    if (childArgs.some((arg) => WINDOWS_CODE_EXECUTION_FLAGS.has(arg.toLowerCase()))) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Windows restricted runner rejects inline code execution; use a workspace script file.",
        killed: false,
        timedOut: false,
        error: "WINDOWS_RESTRICTED_INLINE_CODE",
      };
    }
    const builtin = await executeWindowsWorkspaceBuiltin(
      executable,
      childArgs,
      resolvedCwd,
      workspaceRoot,
      timeout,
      maxOutputSize,
    );
    if (builtin) return builtin;
    const env: Record<string, string> = {
      PATH: process.env.PATH || "",
      USERPROFILE: process.env.USERPROFILE || "",
      TEMP: process.env.TEMP || process.env.TMP || "",
      TMP: process.env.TMP || process.env.TEMP || "",
      SystemRoot: process.env.SystemRoot || "C:\\Windows",
      COMSPEC: process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
      OFFICECLI_RESIDENT_FLUSH: "each",
    };
    for (const [key, value] of Object.entries(options.env || {})) {
      if (isSafeEnvironmentKey(key) && !WINDOWS_PROTECTED_ENV_KEYS.has(key.toUpperCase())) {
        env[key] = String(value);
      }
    }
    for (const key of options.envPassthrough || []) {
      // Only copy explicitly requested, well-formed names that exist in the
      // parent environment. Never allow an option to inject a new value.
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] !== undefined) {
        env[key] = process.env[key] as string;
      }
    }
    let launch;
    try {
      launch = resolveWindowsPackageManagerLaunch(executable, childArgs, resolvedCwd, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stdout: "", stderr: message, killed: false, timedOut: false, error: "WINDOWS_PACKAGE_MANAGER_UNAVAILABLE" };
    }
    return spawnDirectProcess(launch.executable, launch.args, {
      cwd: resolvedCwd,
      env,
      timeout,
      maxOutputSize,
      onProcess: options.onProcess,
    });
  }

  private workspacePath(): string {
    return this.workspace.path;
  }

  /** Exposed only for the restricted command compatibility layer. */
  getWorkspacePath(): string {
    return this.workspace.path;
  }
}

const WINDOWS_PROTECTED_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
]);

export function isSafeEnvironmentKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

const WINDOWS_SHELL_EXECUTABLES = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "sh",
]);
const WINDOWS_CODE_EXECUTION_FLAGS = new Set([
  "-c",
  "/c",
  "-e",
  "-exec",
  "--eval",
  "--exec",
  "--execute",
  "-m",
  "-command",
  "-encodedcommand",
]);

function normalizeWindowsExecutable(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

/** Resolve an existing ancestor when a new output path does not exist yet. */
function resolveCanonicalPath(value: string): string {
  const original = path.resolve(value);
  let candidate = original;
  while (true) {
    try {
      const canonical = realpathSync.native(candidate);
      const suffix = path.relative(candidate, original);
      return suffix ? path.resolve(canonical, suffix) : canonical;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return original;
      candidate = parent;
    }
  }
}

function isPathWithinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const root = resolveCanonicalPath(workspaceRoot);
  const resolved = resolveCanonicalPath(candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function tokenizeDirectWindowsCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        // Backslashes are Windows path separators, not generic escapes.
        token += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += char;
    tokenStarted = true;
  }
  if (quote) return null;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

type WindowsRestrictedCommandPart = {
  command: string;
  operator: "&&" | "||" | ";" | null;
};

function parseWindowsRestrictedSequence(command: string): WindowsRestrictedCommandPart[] | null {
  const parts: WindowsRestrictedCommandPart[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let pendingOperator: WindowsRestrictedCommandPart["operator"] = null;
  let hasOperator = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote && command[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\r" || char === "\n" || char === "<" || char === "^") {
      return null;
    }
    if (char === "|") {
      if (command[index + 1] !== "|") return null;
      const text = command.slice(start, index).trim();
      if (!text) return null;
      parts.push({ command: text, operator: pendingOperator });
      pendingOperator = "||";
      start = index + 2;
      index += 1;
      hasOperator = true;
      continue;
    }
    if (char === ";") {
      const text = command.slice(start, index).trim();
      if (!text) return null;
      parts.push({ command: text, operator: pendingOperator });
      pendingOperator = ";";
      start = index + 1;
      hasOperator = true;
      continue;
    }
    if (char === "&") {
      if (command[index + 1] !== "&") return null;
      const text = command.slice(start, index).trim();
      if (!text) return null;
      parts.push({ command: text, operator: pendingOperator });
      pendingOperator = "&&";
      start = index + 2;
      index += 1;
      hasOperator = true;
    }
  }
  if (quote) return null;
  const last = command.slice(start).trim();
  if (!last) return null;
  parts.push({ command: last, operator: pendingOperator });
  // A single redirection (e.g. officecli ... > report.json) is also handled
  // by this interpreter, while unsupported pipes and shell syntax return null.
  if (!hasOperator && !/>\s*[^>]/.test(command)) return null;
  return parts;
}

function splitWindowsRestrictedRedirection(command: string): {
  command: string;
  target: string;
  append: boolean;
} | null {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote && command[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    const append = command[index + 1] === ">";
    const left = command.slice(0, index).trim();
    const right = command.slice(index + (append ? 2 : 1)).trim();
    if (!left || !right || /[<>|&;]/.test(right)) return null;
    const targetTokens = tokenizeDirectWindowsCommand(right);
    if (!targetTokens || targetTokens.length !== 1) return null;
    return { command: left, target: targetTokens[0], append };
  }
  return { command, target: "", append: false };
}

async function executeWindowsRestrictedSequence(
  sandbox: WindowsRestrictedSandbox,
  parts: WindowsRestrictedCommandPart[],
  options: SandboxOptions,
): Promise<SandboxResult> {
  let cwd = options.cwd || sandbox.getWorkspacePath();
  let previous: SandboxResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    killed: false,
    timedOut: false,
  };
  let stdout = "";
  let stderr = "";
  for (const part of parts) {
    if (part.operator === "&&" && previous.exitCode !== 0) continue;
    if (part.operator === "||" && previous.exitCode === 0) continue;
    const cdMatch = /^(?:cd|chdir)\s+(.+)$/i.exec(part.command);
    if (cdMatch) {
      const tokens = tokenizeDirectWindowsCommand(cdMatch[1]);
      if (!tokens || tokens.length !== 1) {
        previous = {
          exitCode: 1,
          stdout: "",
          stderr: "cd requires one workspace-local path.",
          killed: false,
          timedOut: false,
          error: "WINDOWS_RESTRICTED_INVALID_COMMAND",
        };
      } else {
        const nextCwd = path.resolve(cwd, tokens[0]);
        if (!isPathWithinWorkspace(sandbox.getWorkspacePath(), nextCwd)) {
          previous = {
            exitCode: 1,
            stdout: "",
            stderr: "cd cannot leave the active workspace.",
            killed: false,
            timedOut: false,
            error: "WINDOWS_RESTRICTED_CWD_OUTSIDE_WORKSPACE",
          };
        } else {
          try {
            const stat = await fs.stat(nextCwd);
            if (!stat.isDirectory()) throw new Error("Not a directory");
            cwd = nextCwd;
            previous = { exitCode: 0, stdout: "", stderr: "", killed: false, timedOut: false };
          } catch (error) {
            previous = { exitCode: 1, stdout: "", stderr: String(error), killed: false, timedOut: false };
          }
        }
      }
    } else {
      const redirect = splitWindowsRestrictedRedirection(part.command);
      if (!redirect) {
        previous = {
          exitCode: 1,
          stdout: "",
          stderr: "Invalid workspace-local redirection.",
          killed: false,
          timedOut: false,
          error: "WINDOWS_RESTRICTED_SHELL_SYNTAX",
        };
      } else {
        previous = await sandbox.execute(redirect.command, [], { ...options, cwd });
        if (previous.exitCode === 0 && redirect.target) {
          const target = path.resolve(cwd, redirect.target);
          if (!isPathWithinWorkspace(sandbox.getWorkspacePath(), target)) {
            previous = {
              exitCode: 1,
              stdout: "",
              stderr: "Redirection target must remain inside the active workspace.",
              killed: false,
              timedOut: false,
              error: "WINDOWS_RESTRICTED_CWD_OUTSIDE_WORKSPACE",
            };
          } else {
            await fs.writeFile(target, previous.stdout, { encoding: "utf8", flag: redirect.append ? "a" : "w" });
            previous = { ...previous, stdout: "" };
          }
        }
      }
    }
    stdout += previous.stdout;
    stderr += previous.stderr;
  }
  return { ...previous, stdout, stderr };
}

/**
 * Windows has several useful commands (dir, type, md, del) as cmd.exe
 * built-ins, while agent workflows commonly use their POSIX spellings (ls,
 * pwd, cat, mkdir, rm).  The restricted runner intentionally does not start
 * a shell, so implement this small, workspace-scoped compatibility layer
 * directly with filesystem APIs. This keeps normal validation workflows
 * usable without weakening the no-shell boundary.
 */
async function executeWindowsWorkspaceBuiltin(
  executable: string,
  args: string[],
  cwd: string,
  workspaceRoot: string,
  timeout: number,
  maxOutputSize: number,
): Promise<SandboxResult | null> {
  const name = path.basename(executable).toLowerCase();
  const aliases = new Set([
    "pwd",
    "ls",
    "dir",
    "cat",
    "type",
    "echo",
    "mkdir",
    "md",
    "touch",
    "rm",
    "del",
    "rmdir",
    "rd",
    "cp",
    "copy",
    "mv",
    "move",
    "whoami",
  ]);
  if (!aliases.has(name)) return null;

  const startedAt = Date.now();
  const result = (stdout = "", stderr = "", exitCode = 0): SandboxResult => ({
    exitCode,
    stdout: stdout.slice(0, maxOutputSize),
    stderr: stderr.slice(0, maxOutputSize),
    killed: false,
    timedOut: Date.now() - startedAt > timeout,
  });
  const fail = (message: string) => result("", message, 1);
  const safePath = (value: string): string | null => {
    const resolved = path.resolve(cwd, value || ".");
    if (!isPathWithinWorkspace(workspaceRoot, resolved)) return null;
    return resolved;
  };
  const isFlag = (arg: string): boolean =>
    arg.startsWith("-") || /^\/(?:a|b|s|q|w|p|on|od|o-d|t)$/i.test(arg);
  const nonFlagArgs = args.filter((arg) => !isFlag(arg));

  try {
    if (name === "pwd") return args.length ? fail("pwd does not accept arguments in the restricted runner") : result(`${cwd}\n`);
    if (name === "whoami") return result(`${process.env.USERNAME || process.env.USER || "user"}\n`);
    if (name === "echo") return result(`${args.join(" ")}\n`);

    if (name === "ls" || name === "dir") {
      const includeHidden = args.some((arg) => /(^-|\/)a/i.test(arg));
      const target = safePath(nonFlagArgs[0] || ".");
      if (!target) return fail("Path escapes the active workspace.");
      const entries = await fs.readdir(target, { withFileTypes: true });
      const visible = includeHidden ? entries : entries.filter((entry) => !entry.name.startsWith("."));
      return result(visible.map((entry) => `${entry.name}${entry.isDirectory() ? path.sep : ""}`).join("\n") + (visible.length ? "\n" : ""));
    }

    if (name === "cat" || name === "type") {
      if (nonFlagArgs.length === 0) return fail(`${name} requires a file path.`);
      let output = "";
      for (const value of nonFlagArgs) {
        const target = safePath(value);
        if (!target) return fail("Path escapes the active workspace.");
        output += await fs.readFile(target, "utf8");
      }
      return result(output);
    }

    if (name === "mkdir" || name === "md") {
      if (nonFlagArgs.length === 0) return fail(`${name} requires a directory path.`);
      for (const value of nonFlagArgs) {
        const target = safePath(value);
        if (!target) return fail("Path escapes the active workspace.");
        await fs.mkdir(target, { recursive: true });
      }
      return result();
    }

    if (name === "touch") {
      if (nonFlagArgs.length === 0) return fail("touch requires a file path.");
      for (const value of nonFlagArgs) {
        const target = safePath(value);
        if (!target) return fail("Path escapes the active workspace.");
        await fs.writeFile(target, "", { flag: "a" });
      }
      return result();
    }

    if (["rm", "del", "rmdir", "rd"].includes(name)) {
      if (nonFlagArgs.length === 0) return fail(`${name} requires a path.`);
      const recursive = args.some((arg) => /^-r/i.test(arg) || /^\/s/i.test(arg));
      for (const value of nonFlagArgs) {
        const target = safePath(value);
        if (!target || target === workspaceRoot) return fail("Refusing to delete outside or the root of the active workspace.");
        await fs.rm(target, { recursive, force: true });
      }
      return result();
    }

    if (["cp", "copy", "mv", "move"].includes(name)) {
      if (nonFlagArgs.length !== 2) return fail(`${name} requires a source and destination.`);
      const source = safePath(nonFlagArgs[0]);
      const destination = safePath(nonFlagArgs[1]);
      if (!source || !destination) return fail("Path escapes the active workspace.");
      if (name === "cp" || name === "copy") {
        await fs.cp(source, destination, { recursive: true });
      } else {
        await fs.rename(source, destination);
      }
      return result();
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  return null;
}

function spawnDirectProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxOutputSize: number;
    onProcess?: (process: ChildProcess) => void;
  },
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    options.onProcess?.(child);
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killed = true;
      terminateWindowsProcessTree(child);
      child.kill();
    }, options.timeout);
    const append = (target: "stdout" | "stderr", data: Buffer) => {
      const alreadyTruncated = target === "stdout" ? stdoutTruncated : stderrTruncated;
      if (alreadyTruncated) return;
      const value = decodeProcessOutput(data);
      const current = target === "stdout" ? stdout : stderr;
      const remaining = options.maxOutputSize - current.length;
      const next = current.length + value.length <= options.maxOutputSize
        ? current + value
        : current + value.slice(0, Math.max(0, remaining)) + "\n[Output truncated]";
      if (current.length + value.length > options.maxOutputSize) {
        if (target === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout?.on("data", (data: Buffer) => append("stdout", data));
    child.stderr?.on("data", (data: Buffer) => append("stderr", data));
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      resolve({ exitCode: 1, stdout, stderr: error.message, killed, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      const error = signal ? `Process terminated by signal ${signal}` : undefined;
      resolve({ exitCode: code ?? 1, stdout, stderr: stderr || error || "", killed, timedOut, signal, error });
    });
  });
}

function terminateWindowsProcessTree(child: ChildProcess): void {
  if (process.platform !== "win32" || !child.pid) return;
  try {
    // taskkill is invoked directly, never through a shell, and /T covers
    // interpreters that spawned workers (npm, Python, office helpers, etc.).
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    killer.on("error", () => undefined);
  } catch {
    // The root child.kill() call remains the fallback when taskkill is absent.
  }
}

/**
 * Windows console programs may still emit the system code page (commonly
 * CP936) even when stdout is redirected. Prefer UTF-8, then decode a chunk
 * with GBK only when UTF-8 produced replacement characters. Unix output keeps
 * Node's normal UTF-8 behavior.
 */
export function decodeProcessOutput(data: Buffer): string {
  const utf8 = data.toString("utf8");
  if (process.platform !== "win32" || !utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(data);
  } catch {
    return utf8;
  }
}

/**
 * Cached Docker availability status
 */
let dockerAvailable: boolean | null = null;
let dockerCheckPromise: Promise<boolean> | null = null;
let macOSSandboxAvailable: boolean | null = null;
let macOSSandboxCheckPromise: Promise<boolean> | null = null;

/**
 * Check if Docker is available and running
 */
export async function isDockerAvailable(): Promise<boolean> {
  // Return cached result if available
  if (dockerAvailable !== null) {
    return dockerAvailable;
  }

  // Return existing promise if check is in progress
  if (dockerCheckPromise) {
    return dockerCheckPromise;
  }

  dockerCheckPromise = new Promise((resolve) => {
    const proc = spawn("docker", ["info"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        dockerAvailable = false;
        resolve(false);
      }
    }, 5000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        dockerAvailable = code === 0;
        resolve(dockerAvailable);
      }
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        dockerAvailable = false;
        resolve(false);
      }
    });
  });

  return dockerCheckPromise;
}

/**
 * Check whether macOS sandbox-exec can actually apply a trivial profile.
 * Some local/dev launches have the binary present but sandbox_apply fails or
 * aborts immediately; treating that as available causes every shell command to
 * enter a broken execution path.
 */
export async function isMacOSSandboxAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (macOSSandboxAvailable !== null) {
    return macOSSandboxAvailable;
  }
  if (macOSSandboxCheckPromise) {
    return macOSSandboxCheckPromise;
  }

  macOSSandboxCheckPromise = new Promise((resolve) => {
    const probeSandbox = new MacOSSandbox({
      id: "__macos_sandbox_probe__",
      name: "macOS sandbox probe",
      path: os.tmpdir(),
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: false,
        network: false,
        shell: true,
        unrestrictedFileAccess: false,
        allowedPaths: [],
      },
    });
    let proc: ChildProcess | null = null;
    let resolved = false;
    const finish = (available: boolean) => {
      if (resolved) return;
      resolved = true;
      probeSandbox.cleanup();
      macOSSandboxAvailable = available;
      resolve(available);
    };

    const timeout = setTimeout(() => {
      proc?.kill();
      finish(false);
    }, 3_000);

    void probeSandbox
      .execute("/bin/echo", ["ok"], {
        cwd: os.tmpdir(),
        timeout: 3_000,
        maxOutputSize: 16 * 1024,
        allowNetwork: false,
        onProcess: (child) => {
          proc = child;
        },
      })
      .then((result) => {
        clearTimeout(timeout);
        const combined = `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`;
        const failedRuntime =
          /Operation not permitted|Abort trap|sandbox_apply/i.test(combined);
        finish(
          result.exitCode === 0 &&
            !result.signal &&
            !failedRuntime &&
            result.stdout.trim() === "ok",
        );
      })
      .catch(() => {
        clearTimeout(timeout);
        finish(false);
      });
  });

  return macOSSandboxCheckPromise;
}

/**
 * Detect the best available sandbox type for the current platform
 */
export async function detectAvailableSandbox(): Promise<SandboxType> {
  // On macOS, prefer native sandbox-exec
  if (process.platform === "darwin" && (await isMacOSSandboxAvailable())) {
    return "macos";
  }

  // Check for Docker when native sandboxing is unavailable.
  if (await isDockerAvailable()) {
    return "docker";
  }

  // Windows has no native sandbox-exec. Use the direct, workspace-scoped
  // runner rather than falling through to the generic `none` type, which is
  // intentionally blocked by the shell policy.
  if (process.platform === "win32") {
    return "windows-restricted";
  }

  // Fallback to no sandbox
  return "none";
}

/**
 * Create a sandbox instance for the given workspace
 *
 * @param workspace - The workspace to create a sandbox for
 * @param preferredType - Optional preferred sandbox type (overrides auto-detection)
 * @returns An initialized sandbox instance
 */
export async function createSandbox(
  workspace: Workspace,
  preferredType?: SandboxType | "auto",
): Promise<ISandbox> {
  let sandboxType: SandboxType;

  if (preferredType && preferredType !== "auto") {
    // Validate the preferred type is available
    if (
      preferredType === "macos" &&
      (process.platform !== "darwin" || !(await isMacOSSandboxAvailable()))
    ) {
      console.warn("macOS sandbox requested but unavailable, falling back to auto-detect");
      sandboxType = await detectAvailableSandbox();
    } else if (preferredType === "docker" && !(await isDockerAvailable())) {
      console.warn(
        "Docker sandbox requested but Docker not available, falling back to auto-detect",
      );
      sandboxType = await detectAvailableSandbox();
    } else {
      sandboxType = preferredType;
    }
  } else {
    sandboxType = await detectAvailableSandbox();
  }

  let sandbox: ISandbox;

  switch (sandboxType) {
    case "macos":
      sandbox = new MacOSSandbox(workspace);
      break;
    case "docker":
      sandbox = new DockerSandbox(workspace);
      break;
    case "windows-restricted":
      sandbox = new WindowsRestrictedSandbox(workspace);
      break;
    case "none":
    default:
      sandbox = new NoSandbox(workspace);
      break;
  }

  await sandbox.initialize();
  return sandbox;
}

/**
 * Reset Docker availability cache (useful for testing or after Docker installation)
 */
export function resetDockerCache(): void {
  dockerAvailable = null;
  dockerCheckPromise = null;
}

export function resetMacOSSandboxCache(): void {
  macOSSandboxAvailable = null;
  macOSSandboxCheckPromise = null;
}

export const _testUtils = {
  tokenizeDirectWindowsCommand,
  isPathWithinWorkspace,
};
