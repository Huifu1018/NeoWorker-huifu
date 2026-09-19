import { describe, expect, it } from "vitest";
import { MAX_TRANSLATION_BATCH_UNITS, TRANSLATION_BATCH_JSON_CHARS, TRANSLATION_BATCH_TEXT_CHARS, summarizeTranslationBatch, type TranslationCheckpoint } from "../translation-batches";

function checkpoint(count = 400): TranslationCheckpoint {
  return {
    schema: "neoworker.office-translation.v2", sourceSha256: "source", targetLanguage: "korean",
    completedUnitIds: [],
    units: Array.from({ length: count }, (_, i) => ({ id: `ppt/slides/slide1.xml#${i}`, text: `Source ${i}` })),
  };
}

describe("adaptive translation batches", () => {
  it("packs short units into fewer round trips without omitting or reordering them", () => {
    const state = checkpoint(2287);
    const ids: string[] = [];
    let batches = 0;
    while (state.completedUnitIds.length < state.units.length) {
      const batch = summarizeTranslationBatch(state);
      expect(batch.batchSize).toBeLessThanOrEqual(MAX_TRANSLATION_BATCH_UNITS);
      expect(batch.batchSize).toBeGreaterThan(0);
      expect(JSON.stringify(batch.nextUnits).length).toBeLessThanOrEqual(TRANSLATION_BATCH_JSON_CHARS);
      ids.push(...batch.nextUnits.map((unit) => unit.id));
      state.completedUnitIds.push(...batch.nextUnits.map((unit) => unit.id));
      batches++;
    }
    expect(batches).toBe(15);
    expect(ids).toEqual(state.units.map((unit) => unit.id));
    expect(summarizeTranslationBatch(state)).toMatchObject({ remaining: 0, batchSize: 0, batchId: null });
  });

  it("shrinks batches for long text and context, and always emits one oversized unit intact", () => {
    const state = checkpoint();
    state.units = state.units.map((unit) => ({ ...unit, text: unit.text + "a".repeat(450), context: "b".repeat(200) }));
    const batch = summarizeTranslationBatch(state);
    expect(batch.batchSize).toBeLessThan(40);
    expect(batch.nextUnits.reduce((sum, unit) => sum + unit.text.length + (unit.context?.length || 0), 0)).toBeLessThanOrEqual(TRANSLATION_BATCH_TEXT_CHARS);
    state.units[0].text = "x".repeat(25_000);
    expect(summarizeTranslationBatch(state).nextUnits).toEqual([{ ...state.units[0], key: "u0" }]);
  });

  it("budgets JSON overhead as well as source text", () => {
    const state = checkpoint();
    state.units = state.units.map((unit) => ({ ...unit, id: "p".repeat(1000) + unit.id }));
    const batch = summarizeTranslationBatch(state);
    expect(batch.batchSize).toBeLessThan(40);
    expect(JSON.stringify(batch.nextUnits).length).toBeLessThanOrEqual(TRANSLATION_BATCH_JSON_CHARS);
  });

  it("only deduplicates matching text AND context and retains pending order on resume", () => {
    const state = checkpoint(3);
    state.units = [
      { id: "one", text: "same", context: "A" },
      { id: "two", text: "same", context: "A" },
      { id: "three", text: "same", context: "B" },
    ];
    expect(summarizeTranslationBatch(state).nextUnits.map((unit) => unit.id)).toEqual(["one", "three"]);
    state.completedUnitIds = ["one", "two"];
    expect(summarizeTranslationBatch(state)).toMatchObject({ completed: 2, remaining: 1, uniqueRemaining: 1 });
  });

  it("binds compact replies to source, language, progress, content and order", () => {
    const state = checkpoint();
    const batch = summarizeTranslationBatch(state);
    expect(summarizeTranslationBatch(JSON.parse(JSON.stringify(state))).batchId).toBe(batch.batchId);
    for (const changed of [
      { ...state, sourceSha256: "different" },
      { ...state, targetLanguage: "english" },
      { ...state, completedUnitIds: [state.units[300].id] },
      { ...state, units: state.units.slice().reverse() },
      { ...state, units: state.units.map((unit, i) => i ? unit : { ...unit, text: "changed" }) },
    ]) expect(summarizeTranslationBatch(changed).batchId).not.toBe(batch.batchId);
  });

  it("uses stable short keys even when prior units are completed", () => {
    const state = checkpoint(10);
    const first = summarizeTranslationBatch(state);
    state.completedUnitIds = state.units.slice(0, 5).map((unit) => unit.id);
    const resumed = summarizeTranslationBatch(state);
    expect(resumed.nextUnits.map((unit) => unit.key)).toEqual(first.nextUnits.slice(5).map((unit) => unit.key));
    expect(new Set(first.nextUnits.map((unit) => unit.key)).size).toBe(10);
  });

  it("keeps a paragraph together when it would straddle a batch boundary", () => {
    const state = checkpoint(170);
    for (let i = 150; i < 170; i++) state.units[i].context = "shared paragraph";
    const first = summarizeTranslationBatch(state);
    expect(first.batchSize).toBe(150);
    expect(first.contextSplit).toBe(false);
    state.completedUnitIds = first.nextUnits.map((unit) => unit.id);
    expect(summarizeTranslationBatch(state).batchSize).toBe(20);
  });

  it("bounds a paragraph larger than the batch limit while retaining its context", () => {
    const state = checkpoint(180);
    state.units.forEach((unit) => { unit.context = "shared paragraph"; });
    const first = summarizeTranslationBatch(state);
    expect(first.batchSize).toBe(160);
    expect(first.contextSplit).toBe(true);
    expect(first.nextUnits.every((unit) => unit.context === "shared paragraph")).toBe(true);
    state.completedUnitIds = first.nextUnits.map((unit) => unit.id);
    expect(summarizeTranslationBatch(state)).toMatchObject({ batchSize: 20, contextSplit: false });
  });
});
