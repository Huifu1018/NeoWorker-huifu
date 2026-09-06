import * as fs from "fs";
import * as path from "path";
import {
  validateStandaloneHtmlArtifact,
  type HtmlArtifactValidationOptions,
  type HtmlArtifactValidationResult,
} from "./executor-completion-utils";

export interface HtmlFragmentRecoveryOptions extends HtmlArtifactValidationOptions {
  workspacePath: string;
  targetPath: string;
  prompt?: string;
  /** Optional staging roots, in priority order. */
  fragmentRoots?: string[];
}

export interface HtmlFragmentRecoveryResult {
  success: boolean;
  path?: string;
  sourceDirectory?: string;
  fragmentCount: number;
  bytes?: number;
  validation?: HtmlArtifactValidationResult;
  reason?: string;
}

const DEFAULT_FRAGMENT_ROOTS = [
  path.join(".neoworker", "tmp", "fragments"),
  path.join(".neoworker", "tmp", "parts"),
  path.join(".neoworker", "tmp", "frag"),
  path.join(".neoworker", "fragments"),
  path.join(".neoworker", "parts"),
  path.join(".neoworker", "tmp"),
];

const FRAGMENT_FILE_EXTENSIONS = new Set([".html", ".htm", ".fragment", ".part"]);
const FRAGMENT_NAME_PATTERN = /^(?:\d{1,3}(?:[-_.~]|$)|part[-_.~]?\d|fragment[-_.~]?\d|section[-_.~]?\d|(?:head|body|tail)(?:[-_.~]|$))/i;
const PLACEHOLDER_PATTERN =
  /<!--\s*(?:NEOWORKER_(?:APPEND_POINT|MORE|TODO)|NEOMORE|PART\d+|@NEXT@|__[^>\n]{1,80}__)\s*-->/i;

function resolveInsideWorkspace(workspacePath: string, rawPath: string): string | null {
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);
  if (
    resolved !== workspaceRoot &&
    !resolved.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolved;
}

function isLikelyFragmentFile(name: string): boolean {
  const extension = path.extname(name).toLowerCase();
  if (!FRAGMENT_FILE_EXTENSIONS.has(extension)) return false;
  return FRAGMENT_NAME_PATTERN.test(path.basename(name, extension));
}

function sortFragmentNames(left: string, right: string): number {
  const numericPrefix = (value: string): number => {
    const match = value.match(/^(\d+)/);
    return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  const numericDelta = numericPrefix(left) - numericPrefix(right);
  if (numericDelta !== 0) return numericDelta;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function buildCandidateHtml(existing: string, fragments: string[]): string {
  const joined = fragments.join("\n").trim();
  if (!joined) return "";

  // A complete fragment set is the preferred source: it preserves the head,
  // body, scripts, and closing tags exactly as the generator authored them.
  if (/<html\b[^>]*>/i.test(joined) && /<\/html\s*>/i.test(joined)) {
    return joined;
  }

  if (/<html\b[^>]*>/i.test(existing)) {
    if (PLACEHOLDER_PATTERN.test(existing)) {
      return existing.replace(PLACEHOLDER_PATTERN, joined);
    }
    if (/<\/body\s*>/i.test(existing)) {
      return existing.replace(/<\/body\s*>/i, `${joined}\n</body>`);
    }
    return `${existing.trim()}\n${joined}`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NeoWorker report</title></head>
<body>${joined}</body>
</html>`;
}

/**
 * Recover a final HTML file from model-authored staged fragments without
 * invoking another shell script. This is intentionally conservative: it only
 * considers clearly named HTML fragment files, requires at least two files,
 * validates the assembled document, and writes atomically inside the workspace.
 */
export function recoverHtmlArtifactFromFragments(
  options: HtmlFragmentRecoveryOptions,
): HtmlFragmentRecoveryResult {
  const target = resolveInsideWorkspace(options.workspacePath, options.targetPath);
  if (!target) {
    return { success: false, fragmentCount: 0, reason: "target_outside_workspace" };
  }

  const roots = (options.fragmentRoots || DEFAULT_FRAGMENT_ROOTS)
    .map((root) => resolveInsideWorkspace(options.workspacePath, root))
    .filter((root): root is string => Boolean(root));
  let existing = "";
  try {
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      existing = fs.readFileSync(target, "utf8");
    }
  } catch {
    // A stale/partially-created target must not prevent recovery from the
    // staged fragments. Treat it as absent and let the atomic write below
    // create a fresh final document.
    existing = "";
  }

  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const fragmentEntries = entries
      .filter((entry) => entry.isFile() && isLikelyFragmentFile(entry.name))
      .sort((left, right) => sortFragmentNames(left.name, right.name));
    if (fragmentEntries.length < 2) continue;

    const fragments: string[] = [];
    let totalBytes = 0;
    let unreadable = false;
    for (const entry of fragmentEntries) {
      const fragmentPath = path.join(root, entry.name);
      try {
        const stats = fs.statSync(fragmentPath);
        // Avoid turning an accidentally selected binary/huge file into an
        // unbounded recovery operation.
        if (!stats.isFile() || stats.size > 8 * 1024 * 1024) {
          unreadable = true;
          break;
        }
        const content = fs.readFileSync(fragmentPath, "utf8");
        if (content.trim()) {
          fragments.push(content);
          totalBytes += Buffer.byteLength(content, "utf8");
        }
      } catch {
        unreadable = true;
        break;
      }
    }
    if (unreadable || fragments.length < 2 || totalBytes < 64) continue;

    const candidate = buildCandidateHtml(existing, fragments);
    if (!candidate) continue;
    const validation = validateStandaloneHtmlArtifact(candidate, options.prompt || "", {
      requiredSourceAnchors: options.requiredSourceAnchors,
    });
    if (!validation.valid) continue;

    let temporary = "";
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      temporary = `${target}.neoworker-recovery-${process.pid}-${Date.now()}.tmp`;
      fs.writeFileSync(temporary, candidate, "utf8");
      fs.renameSync(temporary, target);
      return {
        success: true,
        path: target,
        sourceDirectory: root,
        fragmentCount: fragments.length,
        bytes: Buffer.byteLength(candidate, "utf8"),
        validation,
      };
    } catch (error) {
      if (temporary) {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // Best effort only; preserve the original write error for the
          // executor's diagnostics.
        }
      }
      return {
        success: false,
        sourceDirectory: root,
        fragmentCount: fragments.length,
        validation,
        reason: String((error as Error)?.message || error),
      };
    }
  }

  return { success: false, fragmentCount: 0, reason: "no_valid_fragment_set" };
}
