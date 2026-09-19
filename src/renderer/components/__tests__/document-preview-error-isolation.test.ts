import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("contains fullscreen document loading and rendering failures within the preview", () => {
  const source = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile(
    "App.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let found = 0;
  const visit = (node: ts.Node, ancestors: string[]) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(file) === "DocumentArtifactViewer"
    ) {
      const fullscreen = node.attributes.properties.some(
        (prop) =>
          ts.isJsxAttribute(prop) &&
          prop.name.getText(file) === "mode" &&
          prop.initializer &&
          ts.isStringLiteral(prop.initializer) &&
          prop.initializer.text === "fullscreen",
      );
      if (fullscreen) {
        found++;
        expect(ancestors).toContain("WorkbenchPreviewErrorBoundary");
        expect(ancestors).toContain("Suspense");
      }
    }
    const next = ts.isJsxElement(node)
      ? [...ancestors, node.openingElement.tagName.getText(file)]
      : ancestors;
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(file, []);
  expect(found).toBe(1);
});
