import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocxLayoutPreview } from "../DocxLayoutPreview";
import { DOCXDocumentSurface } from "../DOCXDocumentSurface";

describe("DOCX layout and editing isolation", () => {
  it("starts a sandboxed read-only layout surface without edit controls", () => {
    const html = renderToStaticMarkup(React.createElement(DocxLayoutPreview, {
      dataBase64: "", zoom: 1, onOpenExternal: () => {},
    }));
    expect(html).toContain('class="docx-layout-preview"');
    expect(html).toContain('sandbox="allow-same-origin"');
    expect(html).not.toContain("allow-scripts");
    expect(html).not.toContain("contentEditable");
  });

  it("preserves the existing block-selection editor as a separate component", () => {
    const html = renderToStaticMarkup(React.createElement(DOCXDocumentSurface, {
      blocks: [{ id: "p1", type: "paragraph", text: "Original editor", order: 0 }],
      selection: null, onSelectionChange: () => {},
    }));
    expect(html).toContain("Original editor");
    expect(html).toContain('class="docx-block-card ');
    expect(html).not.toContain("iframe");
  });
});
