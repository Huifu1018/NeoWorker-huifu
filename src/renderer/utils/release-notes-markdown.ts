const SAFE_EXTERNAL_PROTOCOL_REGEX = /^(https?:|mailto:|tel:)/i;
const VERSION_SECTION_REGEX = /^##\s+\[?v?\d+\.\d+\.\d+(?:[-+][^\s\]]+)?\]?/i;
const TECHNICAL_METADATA_REGEX =
  /^(?:源码提交|source commit|[-*]\s*(?:macOS|windows|sha256sums?|build json)|.*(?:build json|sha256sums?).*)/i;

/**
 * Keep release notes useful in the app while leaving the full audit trail on
 * GitHub. Generated releases start with commit/package metadata, followed by
 * a version section containing the user-facing changelog.
 */
export function sanitizeReleaseNotesForDisplay(notes: string): string {
  const lines = notes.replace(/\r\n?/g, "\n").split("\n");
  const versionSectionIndex = lines.findIndex((line) =>
    VERSION_SECTION_REGEX.test(line.trim()),
  );

  if (versionSectionIndex >= 0) {
    return lines.slice(versionSectionIndex).join("\n").trim();
  }

  return lines
    .filter((line) => !TECHNICAL_METADATA_REGEX.test(line.trim()))
    .join("\n")
    .replace(/^#\s+NeoWorker\s+v?\d+\.\d+\.\d+\s*\n?/i, "")
    .trim();
}

function getGithubReleaseContext(releaseUrl: string): {
  origin: string;
  owner: string;
  repo: string;
  tag?: string;
} | null {
  try {
    const parsed = new URL(releaseUrl);
    if (parsed.hostname !== "github.com") {
      return null;
    }

    const [, owner, repo, ...rest] = parsed.pathname.split("/");
    if (!owner || !repo) {
      return null;
    }

    const releaseTag =
      rest[0] === "releases" && rest[1] === "tag" ? rest[2] : undefined;
    return {
      origin: parsed.origin,
      owner,
      repo,
      tag: releaseTag,
    };
  } catch {
    return null;
  }
}

export function transformReleaseNotesUrl(
  url: string,
  releaseUrl?: string,
): string {
  const normalized = url.trim();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("#")) {
    return normalized;
  }

  if (SAFE_EXTERNAL_PROTOCOL_REGEX.test(normalized)) {
    return normalized;
  }

  const githubContext = releaseUrl ? getGithubReleaseContext(releaseUrl) : null;
  if (githubContext) {
    if (normalized.startsWith("/")) {
      return `${githubContext.origin}${normalized}`;
    }

    const repoBase = githubContext.tag
      ? `${githubContext.origin}/${githubContext.owner}/${githubContext.repo}/blob/${githubContext.tag}/`
      : `${githubContext.origin}/${githubContext.owner}/${githubContext.repo}/`;

    try {
      return new URL(normalized, repoBase).toString();
    } catch {
      return "";
    }
  }

  if (!releaseUrl) {
    return "";
  }

  if (normalized.startsWith("/")) {
    try {
      return new URL(normalized, releaseUrl).toString();
    } catch {
      return "";
    }
  }

  try {
    return new URL(normalized, releaseUrl).toString();
  } catch {
    return "";
  }
}
