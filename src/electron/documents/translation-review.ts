import type { OfficeTranslationUnit } from "./office-translation";

type ReviewIssue = {
  id: string;
  reasons: Array<"numbers_changed" | "unchanged_sentence" | "extreme_length_change">;
  source: string;
  translation: string;
};

// Heuristics are review hints, not a language-quality verdict or a delivery gate.
export function reviewTranslationUnits(source: OfficeTranslationUnit[], translations: Map<string, string>) {
  const issues: ReviewIssue[] = [];
  let issueCount = 0;
  let checkedUnits = 0;
  const numbers = (text: string) => (text.normalize("NFKC").match(/[+-]?\d+(?:[.,]\d+)*(?:%|\u2030)?/g) || []).sort();
  for (const unit of source) {
    const translated = translations.get(unit.id);
    if (translated === undefined) continue;
    checkedUnits++;
    const before = unit.text.trim();
    const after = translated.trim();
    const reasons: ReviewIssue["reasons"] = [];
    const originalNumbers = numbers(before);
    if (originalNumbers.length && JSON.stringify(originalNumbers) !== JSON.stringify(numbers(after))) reasons.push("numbers_changed");
    const letterCount = (before.match(/\p{L}/gu) || []).length;
    if (before === after && before.length >= 24 && letterCount >= 12
      && (before.split(/\s+/).length >= 4 || (before.match(/\p{Script=Han}/gu) || []).length >= 12)) reasons.push("unchanged_sentence");
    if (before.length >= 40 && letterCount >= 20
      && (after.length < before.length * 0.2 || after.length > before.length * 5)) reasons.push("extreme_length_change");
    if (reasons.length) {
      issueCount++;
      // Bound tool-result size; do not resend the document on every stage.
      if (issues.length < 8) issues.push({ id: unit.id, reasons, source: before.slice(0, 300), translation: after.slice(0, 300) });
    }
  }
  return {
    status: issueCount ? "needs_review" : "no_heuristic_flags",
    semanticAccuracy: "not_verified",
    checkedUnits,
    issueCount,
    issues,
    truncated: issueCount > issues.length,
    guidance: "These are heuristic review hints, not confirmed errors. Numeric localization, identifiers or same-language text can be legitimate. Review flagged units in the original context; correct with explicit units only when needed. Do not claim translation accuracy from this check or retry unchanged warnings in a loop.",
  };
}
