const PRESENTATION_PROJECT_SEGMENT =
  /(^|\/)(?:presentation-studio|visual-presentation|ppt-master)(?:\/|$)/i;
const PRESENTATION_SLIDE_SOURCE =
  /(^|\/)(?:slide-\d+|s\d+)(?:-[^/]*)?\.(?:mjs|cjs|js|ts)$/i;
const INTERNAL_OFFICE_PATH =
  /(^|\/)\.neoworker\/(?:tmp|office-staging|office-quality|office-manifests|office-snapshots)(?:\/|$)/i;
const PRESENTATION_WORKING_FILE =
  /(^|\/)(?:presentation-plan\.json|theme\.json|narrative\.md|render-report\.json|qa-report\.json)$/i;
const INTERNAL_VALIDATION_ARTIFACT_FILE =
  /(^|\/)(?:[^/]*[-_.])?(?:preview|render|quality|visual|qa)[-_.]?(?:check|evidence|inspection)(?:[-_.][^/]*)?\.(?:html?|md|txt|json|pdf)$/i;
const INTERNAL_AGENT_CONTEXT_PATH =
  /(^|\/)agent\.md(?:\/(?:soul\.md)(?:\/user\.md)?)?(?:\/|$)/i;
const INTERNAL_DIAGNOSTIC_ARTIFACT_FILE =
  /(^|\/)_{1,2}(?:diag|diagnostic|partial|verify|verification)(?:[-_.]|$)/i;
const INTERNAL_OFFICE_CHUNK_JSON_FILE =
  /(^|\/)s\d+_(?:h|r\d{1,3}_\d{1,3})\.json$/i;
const INTERNAL_OFFICE_ROOT_WORK_DIR =
  /^(?:pptxwork|tr)(?:\/|$)/i;

function normalizeArtifactPath(rawPath: unknown): string {
  if (typeof rawPath !== "string") return "";
  return rawPath.trim().replace(/\\/g, "/");
}

function toWorkspaceRelativePath(
  normalizedPath: string,
  rawWorkspacePath?: unknown,
): string {
  const workspacePath = normalizeArtifactPath(rawWorkspacePath);
  if (
    workspacePath &&
    (normalizedPath === workspacePath ||
      normalizedPath.startsWith(`${workspacePath}/`))
  ) {
    return normalizedPath.slice(workspacePath.length).replace(/^\/+/, "");
  }
  return normalizedPath.replace(/^\/+/, "");
}

export function isInternalWorkspaceProcessPath(
  rawPath: unknown,
  workspacePath?: unknown,
): boolean {
  const normalized = normalizeArtifactPath(rawPath);
  if (!normalized) return false;
  const relativePath = toWorkspaceRelativePath(normalized, workspacePath);

  if (INTERNAL_OFFICE_PATH.test(normalized)) return true;
  if (INTERNAL_AGENT_CONTEXT_PATH.test(normalized)) return true;
  if (INTERNAL_DIAGNOSTIC_ARTIFACT_FILE.test(normalized)) return true;
  if (INTERNAL_VALIDATION_ARTIFACT_FILE.test(normalized)) return true;
  if (INTERNAL_OFFICE_ROOT_WORK_DIR.test(relativePath)) return true;
  if (/\.pptx$/i.test(normalized)) return false;
  if (PRESENTATION_PROJECT_SEGMENT.test(relativePath)) return true;
  if (PRESENTATION_SLIDE_SOURCE.test(relativePath)) return true;
  if (PRESENTATION_WORKING_FILE.test(relativePath)) return true;
  if (INTERNAL_OFFICE_CHUNK_JSON_FILE.test(relativePath)) return true;

  return false;
}

/**
 * Source-first presentation workflows intentionally create a project tree
 * containing slide modules, prompts, previews, theme data, and QA reports.
 * Those files remain available in the workspace, but they are implementation
 * details rather than deliverables and must not flood task artifact surfaces.
 */
export function isUserVisibleTaskArtifactPath(rawPath: unknown): boolean {
  const normalized = normalizeArtifactPath(rawPath);
  if (!normalized) return false;

  if (
    INTERNAL_OFFICE_PATH.test(normalized) ||
    INTERNAL_AGENT_CONTEXT_PATH.test(normalized) ||
    INTERNAL_DIAGNOSTIC_ARTIFACT_FILE.test(normalized) ||
    INTERNAL_VALIDATION_ARTIFACT_FILE.test(normalized)
  ) {
    return false;
  }
  // A published deck remains a user-facing deliverable even when its
  // canonical copy lives under a presentation skill directory.
  if (/\.pptx$/i.test(normalized)) return true;
  if (isInternalWorkspaceProcessPath(normalized)) return false;

  return true;
}
