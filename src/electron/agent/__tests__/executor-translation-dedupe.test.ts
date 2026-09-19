import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCallDeduplicator } from "../executor-helpers";

afterEach(() => vi.restoreAllMocks());

function batch(offset: number, sourcePath = "source.pptx") {
  return {
    action: "stage",
    sourcePath,
    translationsPath: ".neoworker-translation.json",
    units: Array.from({ length: 40 }, (_, index) => ({
      id: `ppt/slides/slide1.xml#${offset + index}`,
      text: `Translated unit ${offset + index}`,
    })),
  };
}

describe("translation batch duplicate detection", () => {
  it.each(["/workspace/source.pptx", "C:\\Users\\tester\\source.pptx"])(
    "allows 67 distinct batches for %s without resetting loop protection",
    (sourcePath) => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const deduper = new ToolCallDeduplicator(3, 120_000, 4);
      for (let index = 0; index < 67; index++) {
        const input = batch(index * 40, sourcePath);
        expect(deduper.checkDuplicate("office_translation", input).isDuplicate).toBe(false);
        deduper.recordCall("office_translation", input, '{"success":true}');
        now += 10_000;
      }
    },
  );

  it("still blocks identical nested parameters regardless of object key order", () => {
    const deduper = new ToolCallDeduplicator(3, 120_000, 4);
    const input = batch(0);
    for (let index = 0; index < 3; index++) {
      deduper.recordCall("office_translation", input, '{"completed":40}');
    }
    const reordered = {
      units: input.units.map(({ id, text }) => ({ text, id })),
      translationsPath: input.translationsPath,
      sourcePath: input.sourcePath,
      action: input.action,
    };
    expect(deduper.checkDuplicate("office_translation", reordered)).toMatchObject({
      isDuplicate: true,
      cachedResult: '{"completed":40}',
    });
  });

  it("allows corrected nested text after a rejected batch, but blocks the unchanged invalid batch", () => {
    const deduper = new ToolCallDeduplicator();
    const invalid = batch(0);
    invalid.units[0].text = "";
    deduper.recordCall("office_translation", invalid, JSON.stringify({
      success: false, invalid_input: true, error: "Invalid parameter units: empty translation",
    }));
    expect(deduper.checkDuplicate("office_translation", invalid).isDuplicate).toBe(true);
    expect(deduper.checkDuplicate("office_translation", batch(0)).isDuplicate).toBe(false);
    expect(deduper.checkDuplicate("office_translation", batch(40)).isDuplicate).toBe(false);
  });

  it("allows the same apply again after a successful checkpoint stage", () => {
    const deduper = new ToolCallDeduplicator(3, 120_000, 4);
    const apply = { action: "apply", translationId: "translation.json", filename: "translated.pptx" };
    for (let index = 0; index < 3; index++) deduper.recordCall("office_translation", apply, JSON.stringify({ success: false }));
    expect(deduper.checkDuplicate("office_translation", apply).isDuplicate).toBe(true);
    deduper.recordCall("office_translation", { action: "stage", translationId: "translation.json", batchId: "next" },
      JSON.stringify({ success: true, completed: 440, remaining: 0 }));
    expect(deduper.checkDuplicate("office_translation", apply).isDuplicate).toBe(false);
  });

  it.each(["inspect", "unrelated", "no-progress"])("does not reset apply protection after %s", (kind) => {
    const deduper = new ToolCallDeduplicator(2);
    const apply = { action: "apply", translationId: "one.json", filename: "translated.pptx" };
    for (let i = 0; i < 2; i++) deduper.recordCall("office_translation", apply, '{"success":false}');
    deduper.recordCall("office_translation", { action: kind === "inspect" ? "inspect" : "stage",
      translationId: kind === "unrelated" ? "two.json" : "one.json" },
    JSON.stringify({ success: true, accepted: kind === "no-progress" ? 0 : 1 }));
    expect(deduper.checkDuplicate("office_translation", apply).isDuplicate).toBe(true);
  });

  it("still blocks repeated identical successful stages", () => {
    const deduper = new ToolCallDeduplicator(2);
    const input = { action: "stage", translationId: "one.json", batchId: "same", translations: [{ key: "u1", text: "訳" }] };
    for (let i = 0; i < 2; i++) {
      expect(deduper.checkDuplicate("office_translation", input).isDuplicate).toBe(false);
      deduper.recordCall("office_translation", input, '{"success":true,"accepted":1}');
    }
    expect(deduper.checkDuplicate("office_translation", input).isDuplicate).toBe(true);
  });

  it.each([
    [{ nested: { value: 1 } }, { nested: { value: "1" } }],
    [{ nested: { value: null } }, { nested: {} }],
    [{ nested: [{ id: 1 }, { id: 2 }] }, { nested: [{ id: 2 }, { id: 1 }] }],
    [{ nested: { text: "a".repeat(210_000) + "one" } }, { nested: { text: "a".repeat(210_000) + "two" } }],
  ])("compares the entire JSON value without losing nested types or array order", (first, second) => {
    const deduper = new ToolCallDeduplicator(1);
    deduper.recordCall("json_tool", first, '{"success":true}');
    expect(deduper.checkDuplicate("json_tool", second).isDuplicate).toBe(false);
    expect(deduper.checkDuplicate("json_tool", first).isDuplicate).toBe(true);
  });
});
