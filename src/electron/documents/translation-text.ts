export function translationTextIssue(text: unknown): string | undefined {
  if (typeof text !== "string" || !text.trim()) return "empty_or_non_string";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) return "control_character";
  // Do not treat language-specific letters, combining marks or bidi controls as corruption.
  if (/\uFFFD|\p{Surrogate}/u.test(text)) return "invalid_unicode";
  return undefined;
}
