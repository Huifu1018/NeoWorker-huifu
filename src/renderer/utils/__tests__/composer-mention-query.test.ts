import { describe, expect, it } from "vitest";
import { findComposerMentionQuery } from "../composer-mention-query";

const labels = ["测试工程师", "代码评审员", "Code Reviewer", "Browser", "everybody"];
const query = (text: string) => findComposerMentionQuery(text, text.length, labels);

describe("composer mention query", () => {
  it("closes after a selected agent and subsequent prose", () => {
    for (const text of ["@测试工程师 ", "@测试工程师 帮我分析一下代码", "@测试工程师\t分析代码", "@everybody do this"]) {
      expect(query(text)).toBeNull();
    }
  });
  it("allows partial and multiword names", () => {
    expect(query("@测")?.query).toBe("测");
    expect(query("@Code Re")?.query).toBe("Code Re");
    expect(query("@Code Reviewer review this")).toBeNull();
  });
  it("reopens only for a new mention or editing inside an existing name", () => {
    expect(query("@测试工程师 帮我分析 @")?.query).toBe("");
    expect(findComposerMentionQuery("@测试工程师 帮我分析", 3, labels)?.query).toBe("测试");
  });
  it("does not search email addresses, newlines or whitespace after the marker", () => {
    for (const text of ["a@example.com", "@测试工程师\n正文", "@ ", "@\t"]) {
      expect(query(text)).toBeNull();
    }
    expect(findComposerMentionQuery("@", null, labels)).toBeNull();
  });
});
