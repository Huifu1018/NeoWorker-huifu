import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../FileViewer.tsx", import.meta.url)),
  "utf8",
);
const rendererIndexSource = readFileSync(
  fileURLToPath(new URL("../../index.html", import.meta.url)),
  "utf8",
);
const electronMainSource = readFileSync(
  fileURLToPath(new URL("../../../electron/main.ts", import.meta.url)),
  "utf8",
);
const fileViewerSource = readFileSync(
  fileURLToPath(new URL("../FileViewer.tsx", import.meta.url)),
  "utf8",
);
const inlineHtmlPreviewSource = readFileSync(
  fileURLToPath(new URL("../InlineHtmlPreview.tsx", import.meta.url)),
  "utf8",
);
const webArtifactViewerSource = readFileSync(
  fileURLToPath(new URL("../WebArtifactViewer.tsx", import.meta.url)),
  "utf8",
);
const htmlPreviewSandboxSource = readFileSync(
  fileURLToPath(new URL("../htmlPreviewSandbox.ts", import.meta.url)),
  "utf8",
);
const webPreviewProtocolSource = readFileSync(
  fileURLToPath(
    new URL("../../../electron/web-preview/web-preview-protocol.ts", import.meta.url),
  ),
  "utf8",
);
const globalStylesSource = readFileSync(
  fileURLToPath(new URL("../../styles/index.css", import.meta.url)),
  "utf8",
);
const artifactViewerStylesSource = readFileSync(
  fileURLToPath(new URL("../artifact-viewers.css", import.meta.url)),
  "utf8",
);

describe("file preview recovery", () => {
  it("offers both an in-place retry and opening the original file", () => {
    expect(source).toContain('t("fileViewer.retryPreview", "Retry preview")');
    expect(source).toContain("onClick={() => void loadFile()}");
    expect(source).toContain("onClick={handleOpenExternal}");
    expect(source).toContain(
      't("fileViewer.openWithDefaultApp", "Open with Default App")',
    );
  });

  it("allows tokenized local HTML pages to load inside the artifact iframe", () => {
    expect(rendererIndexSource).toContain("frame-src 'self' web-preview:;");
    expect(electronMainSource).toContain("\"frame-src 'self' web-preview:; \"");
    expect(fileViewerSource).toContain("src={previewUrl}");
    expect(fileViewerSource).toContain("fileData.webPreview?.canPreview");
    expect(inlineHtmlPreviewSource).toContain("src={previewUrl}");
    expect(inlineHtmlPreviewSource).toContain("result?.webPreview?.canPreview");
    expect(webArtifactViewerSource).toContain("preview?.canPreview && preview.previewUrl");
    expect(webArtifactViewerSource).toContain("src={previewUrl}");
    expect(webArtifactViewerSource).toContain("HTML_PREVIEW_SRCDOC_SANDBOX");
    expect(htmlPreviewSandboxSource).toContain("allow-popups");
    expect(htmlPreviewSandboxSource).toContain("allow-top-navigation-by-user-activation");
    expect(htmlPreviewSandboxSource).toContain("allow-downloads");
    expect(htmlPreviewSandboxSource).toContain("HTML_PREVIEW_SRCDOC_SANDBOX");
    expect(webPreviewProtocolSource).toContain('".avif": "image/avif"');
    expect(webPreviewProtocolSource).toContain('".csv": "text/csv; charset=utf-8"');
    expect(webPreviewProtocolSource).toContain('".glb": "model/gltf-binary"');
    expect(webPreviewProtocolSource).toContain('".webmanifest"');
    expect(webPreviewProtocolSource).toContain('".mp4": "video/mp4"');
  });

  it("keeps converted Word media inside the document page", () => {
    expect(globalStylesSource).toMatch(
      /\.file-viewer-docx img,[\s\S]*?max-width:\s*100%;[\s\S]*?height:\s*auto;[\s\S]*?object-fit:\s*contain;/,
    );
    expect(artifactViewerStylesSource).toMatch(
      /\.document-viewer-html img,[\s\S]*?max-width:\s*100%;[\s\S]*?height:\s*auto;[\s\S]*?object-fit:\s*contain;/,
    );
  });
});
