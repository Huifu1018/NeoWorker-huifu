const VISIBILITY_GUARD_ATTRIBUTE = "data-neoworker-content-visibility-guard";

/**
 * Markers used while an agent is assembling an HTML artifact. These markers
 * must never be presented as a finished, previewable page.
 *
 * `NEOWORKER_APPEND_POINT` is intentionally not included here: it is the
 * supported append sentinel for a page that already has real body content.
 */
const HTML_STAGING_PLACEHOLDER_PATTERNS = [
  /<!--\s*@NEXT@\s*-->/i,
  /<!--\s*(?:##|@@)[^>\n]{1,120}(?:##|@@)\s*-->/i,
  /\/\*\s*(?:##|@@)[A-Z0-9_.:-]{1,120}(?:##|@@)\s*\*\//i,
  /\/\/\s*(?:##|@@)[A-Z0-9_.:-]{1,120}(?:##|@@)/i,
  /\/\*\s*__+[A-Z0-9_.:-]{1,120}__+\s*\*\//i,
  /<!--\s*__+[A-Z0-9_.:-]{1,120}__+\s*-->/i,
  /<!--\s*NEOWORKER_(?:MORE|TODO)\s*-->/i,
];

export function containsHtmlStagingPlaceholder(content: string): boolean {
  return HTML_STAGING_PLACEHOLDER_PATTERNS.some((pattern) =>
    pattern.test(String(content || "")),
  );
}

export function isHtmlBootstrapPlaceholder(content: string): boolean {
  const value = String(content || "").trim();
  return (
    value.length <= 1024 &&
    /<p\b[^>]*>\s*Bootstrap artifact stub\.\s*<\/p>/i.test(value)
  );
}

/**
 * Return a user-facing reason when an HTML file is structurally incomplete or
 * still contains an assembly marker. A page with a bootstrap stub is handled
 * separately by the UI as a loading state, so it is not reported here.
 */
export function getHtmlContentPreviewProblem(content: string): string | null {
  const html = String(content || "").trim();
  if (!html) return "HTML 内容为空，尚未生成完成。";
  if (isHtmlBootstrapPlaceholder(html)) return null;
  if (containsHtmlStagingPlaceholder(html)) {
    return "HTML 仍包含未替换的生成占位符，尚未拼装完成。";
  }

  // Browser previews also accept HTML fragments such as `<main>...</main>`.
  // Only apply the empty-body check when the file declares a full document;
  // structural completeness remains the responsibility of the task guard.
  if (!/<html\b[^>]*>/i.test(html) || !/<\/html\s*>/i.test(html)) {
    return null;
  }
  if (!/<body\b[^>]*>/i.test(html) || !/<\/body\s*>/i.test(html)) {
    return "HTML 文档尚未完整写入，缺少完整的 body 结构。";
  }

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  const body = bodyMatch?.[1] || "";
  const executableScript = body.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
  const hasExecutableScript = executableScript?.some((script) =>
    script
      .replace(/<script\b[^>]*>|<\/script\s*>/gi, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .trim().length >= 16,
  );
  const hasRenderableElement = /<(?:canvas|img|svg|video|audio|iframe|form|table|input|button)\b/i.test(
    body,
  );
  const bodyText = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!bodyText && !hasRenderableElement && !hasExecutableScript) {
    return "HTML 的 body 为空，内容尚未生成完成。";
  }
  return null;
}

export interface HtmlContentVisibilityRepairResult {
  content: string;
  repaired: boolean;
  reasons: string[];
}

function isHtmlDocument(content: string): boolean {
  return /<(?:!doctype\s+html|html|head|body)\b/i.test(content);
}

function containsRevealContent(content: string): boolean {
  return (
    /class\s*=\s*["'][^"']*\breveal\b[^"']*["']/i.test(content) ||
    /\bdata-reveal(?:\s|=|\/?>)/i.test(content)
  );
}

function hasUnsafeRevealDefaults(content: string): boolean {
  const cssRulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = cssRulePattern.exec(content))) {
    const selector = match[1];
    const declarations = match[2];
    if (!/(?:\.reveal\b|\[data-reveal(?:\]|=))/i.test(selector)) continue;
    if (
      /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:!important\s*)?(?:;|$)/i.test(declarations) ||
      /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:!important\s*)?(?:;|$)/i.test(declarations)
    ) {
      return true;
    }
  }
  return false;
}

export function repairHiddenHtmlContent(content: string): HtmlContentVisibilityRepairResult {
  if (
    !isHtmlDocument(content) ||
    content.includes(VISIBILITY_GUARD_ATTRIBUTE) ||
    !containsRevealContent(content) ||
    !hasUnsafeRevealDefaults(content)
  ) {
    return { content, repaired: false, reasons: [] };
  }

  const guard = [
    `  <style ${VISIBILITY_GUARD_ATTRIBUTE}="true">`,
    "    /* Generated content must remain readable when animation hooks fail. */",
    "    .reveal, [data-reveal] {",
    "      opacity: 1 !important;",
    "      visibility: visible !important;",
    "    }",
    "  </style>",
  ].join("\n");

  const repairedContent = /<\/head\s*>/i.test(content)
    ? content.replace(/<\/head\s*>/i, `${guard}\n</head>`)
    : `${guard}\n${content}`;

  return {
    content: repairedContent,
    repaired: true,
    reasons: ["reveal content was hidden by default and depended on JavaScript to become visible"],
  };
}
