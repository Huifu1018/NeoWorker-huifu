import { describe, expect, it } from "vitest";

import { isBootstrapHtmlPlaceholder } from "../InlineHtmlPreview";
import { getHtmlContentPreviewProblem } from "../../../shared/html-content-visibility";

describe("inline HTML preview layout", () => {
  it("recognizes the provisional bootstrap document", () => {
    expect(
      isBootstrapHtmlPlaceholder(
        '<!doctype html><html><head><title>Draft</title></head><body><p>Bootstrap artifact stub.</p></body></html>',
      ),
    ).toBe(true);
  });

  it("does not collapse a completed document that mentions bootstrap text", () => {
    expect(
      isBootstrapHtmlPlaceholder(
        `<html><body><main><h1>Report</h1><p>Bootstrap artifact stub.</p>${"<section>Content</section>".repeat(80)}</main></body></html>`,
      ),
    ).toBe(false);
  });

  it("flags an HTML skeleton with the interrupted assembly marker", () => {
    expect(
      getHtmlContentPreviewProblem(
        "<!doctype html><html><head><style>body{color:#111}</style></head><body><!--@NEXT@--></body></html>",
      ),
    ).toContain("占位符");
  });

  it("keeps a valid HTML fragment previewable", () => {
    expect(getHtmlContentPreviewProblem("<main>完成内容</main>")).toBeNull();
  });

  it("does not reject a completed page merely because it mentions bootstrap text", () => {
    expect(
      getHtmlContentPreviewProblem(
        "<html><body><main><h1>Report</h1><p>Bootstrap artifact stub.</p></main></body></html>",
      ),
    ).toBeNull();
  });
});
