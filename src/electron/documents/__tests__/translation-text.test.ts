import { describe, expect, it } from "vitest";
import { translationTextIssue } from "../translation-text";

describe("translation text validation", () => {
  it.each(["中文", "日本語", "한국어", "العَرَبِيَّة", "עברית", "Français déjà", "Tiếng Việt", "हिन्दी", "\u2067العربية\u2069 NVIDIA", "e\u0301", "\u{1f680}"])("preserves valid multilingual text %s", (text) => {
    expect(translationTextIssue(text)).toBeUndefined();
  });
  it.each([null, "", "  ", "bad\uFFFD", "\ud800", "bad\u0001"])("rejects invalid text %j", (text) => {
    expect(translationTextIssue(text)).toBeDefined();
  });
});
