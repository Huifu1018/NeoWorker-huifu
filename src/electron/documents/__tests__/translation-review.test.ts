import { describe, expect, it } from "vitest";
import { reviewTranslationUnits } from "../translation-review";

function review(source: string, translation: string) {
  return reviewTranslationUnits([{ id: "u1", text: source }], new Map([["u1", translation]]));
}

describe("translation review hints", () => {
  it("flags changed or missing numeric values without claiming a semantic verdict", () => {
    expect(review("Capacity 384, speed 2.5%", "Capacity 38, speed 2.5%")).toMatchObject({
      status: "needs_review", semanticAccuracy: "not_verified", issueCount: 1,
      issues: [{ id: "u1", reasons: ["numbers_changed"] }],
    });
    expect(review("Capacity 384", "Capacity").issueCount).toBe(1);
    expect(review("Capacity 384, speed 2.5%", "Speed 2.5%, capacity 384").issueCount).toBe(0);
  });

  it("flags unchanged sentences but does not require changing short product identifiers", () => {
    const sentence = "This sentence should be checked before reporting translation complete.";
    expect(review(sentence, sentence).issues[0].reasons).toContain("unchanged_sentence");
    expect(review("NVIDIA GB200", "NVIDIA GB200")).toMatchObject({ issueCount: 0, semanticAccuracy: "not_verified" });
  });

  it("flags severe shortening and expansion as advisory only", () => {
    const source = "Long sentence with important operational requirements and detailed technical constraints.";
    expect(review(source, "Done").issues[0].reasons).toContain("extreme_length_change");
    expect(review(source, source.repeat(6)).issues[0].reasons).toContain("extreme_length_change");
  });

  it("bounds emitted evidence while counting all suspicious units and skips unstaged units", () => {
    const units = Array.from({ length: 20 }, (_, i) => ({ id: `u${i}`, text: `Capacity ${100 + i}` }));
    const result = reviewTranslationUnits(units, new Map(units.slice(0, 15).map((unit) => [unit.id, "Translated capacity"])));
    expect(result).toMatchObject({ checkedUnits: 15, issueCount: 15, truncated: true });
    expect(result.issues).toHaveLength(8);
  });
});
