import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../DocumentAwareFileModal.tsx", import.meta.url)),
  "utf8",
);

describe("DocumentAwareFileModal", () => {
  it("uses the basic file viewer for Word attachments", () => {
    expect(source).toContain('import { FileViewer } from "./FileViewer";');
    expect(source).not.toContain(
      'import { DocumentEditorModal } from "./DocumentEditorModal";',
    );
    expect(source).not.toContain("<DocumentEditorModal");
    expect(source).toContain(
      'variant={lowerPath.endsWith(".pdf") ? "side-pane" : "modal"}',
    );
  });

  it("keeps PDF side-pane behavior while all other formats use the regular viewer", () => {
    expect(source).toContain('lowerPath.endsWith(".pdf") ? "side-pane" : "modal"');
    expect(source).toContain("Opening an attachment is a preview action.");
  });
});
