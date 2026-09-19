import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PresentationArtifactViewer } from "../PresentationArtifactViewer";
import { PresentationViewer } from "../PresentationViewer";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("PresentationArtifactViewer", () => {
  it("shows a text warning without discarding rendered slide images", () => {
    const markup = render(React.createElement(PresentationViewer, {
      fileName: "sample.pptx",
      preview: { slideCount: 1, renderStatus: "rendered", renderMessage: "Text encoding warning on slide(s): 1.", textWarningPages: [1],
        slides: [{ index: 1, text: "Text", imageUrl: "media://local/slide-token" }] },
      onOpenExternal: () => {}, onShowInFinder: () => {},
    }));
    expect(markup).toContain("media://local/slide-token");
    expect(markup).toMatch(/Possible text encoding issues on slide\(s\) 1|第 1 页文字可能存在编码异常/);
    expect(markup).not.toMatch(/Original layout preview is unavailable|暂时无法预览原版式/);
  });
  it("shows the presentation filename only in the header", () => {
    const markup = render(
      React.createElement(PresentationArtifactViewer, {
        filePath: "/workspace/sample.pptx",
        workspacePath: "/workspace",
        mode: "sidebar",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
      }),
    );

    expect(markup.match(/sample\.pptx/g)?.length).toBe(1);
    expect(markup).toMatch(/Open presentation in full screen|全屏打开演示文稿/);
    expect(markup).toContain("presentation-artifact-viewer-tab-meta");
    expect(markup).not.toContain("presentation-artifact-viewer-titlebar");
  });

  it("keeps the latest update visible when fullscreen turn context is collapsed", () => {
    const markup = render(
      React.createElement(PresentationArtifactViewer, {
        filePath: "/workspace/sample.pptx",
        workspacePath: "/workspace",
        mode: "fullscreen",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
        onSendMessage: async () => {},
        turnContext: {
          statusLabel: "Latest turn",
          summary: "Created the sample deck.",
          artifactPath: "/workspace/sample.pptx",
          artifactName: "sample.pptx",
        },
      }),
    );

    expect(markup).toContain("spreadsheet-viewer-turn-frame collapsed");
    expect(markup).toContain("Latest turn");
    expect(markup).toContain("Created the sample deck.");
  });

  it("renders review controls before a PPTX preview is loaded", () => {
    const markup = render(
      React.createElement(PresentationArtifactViewer, {
        filePath: "/workspace/sample.pptx",
        workspacePath: "/workspace",
        mode: "sidebar",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
      }),
    );

    expect(markup).toContain("PPTX");
    expect(markup).toMatch(/Copy|复制/);
    expect(markup).toMatch(/Folder|文件夹/);
    expect(markup).toMatch(/Download|下载/);
  });

  it("renders a dedicated loading preview while slide images are still rendering", () => {
    const markup = render(
      React.createElement(PresentationViewer, {
        fileName: "sample.pptx",
        preview: {
          slideCount: 1,
          renderStatus: "rendering",
          renderMessage: "Rendering slide previews...",
          slides: [{ index: 1, title: "Intro", text: "Opening slide" }],
        },
        onOpenExternal: () => {},
        onShowInFinder: () => {},
      }),
    );

    expect(markup).toMatch(/Rendering previews|正在渲染预览/);
    expect(markup).toMatch(/Preparing slide preview|正在生成幻灯片预览/);
    expect(markup).toContain("presentation-viewer-thumb-placeholder");
    expect(markup).not.toContain("Opening slide");
    expect(markup).not.toContain("Rendering slide previews...");
  });

  it("labels extracted text as a fallback without exposing raw renderer errors", () => {
    const markup = render(React.createElement(PresentationViewer, {
      fileName: "sample.pptx",
      preview: {
        slideCount: 1,
        renderStatus: "text_only",
        renderMessage: "spawn soffice ENOENT",
        slides: [{ index: 1, title: "Intro", text: "Opening slide" }],
      },
      onOpenExternal: () => {},
      onShowInFinder: () => {},
    }));
    expect(markup).toMatch(/Original layout preview is unavailable|暂时无法预览原版式/);
    expect(markup).toContain("Opening slide");
    expect(markup).not.toContain("spawn soffice");
    expect(markup).not.toContain("<h3>");
  });

  it("uses tokenized image URLs when rendered slide images are available", () => {
    const markup = render(
      React.createElement(PresentationViewer, {
        fileName: "sample.pptx",
        preview: {
          slideCount: 1,
          renderStatus: "rendered",
          slides: [
            {
              index: 1,
              title: "Intro",
              text: "Opening slide",
              imageUrl: "media://local/slide-token",
            },
          ],
        },
        onOpenExternal: () => {},
        onShowInFinder: () => {},
      }),
    );

    expect(markup).toContain("media://local/slide-token");
    expect(markup).toMatch(/1 rendered|已渲染 1 张/);
  });

  it("keeps the compatibility notice visible for cached bundled previews", () => {
    const markup = render(React.createElement(PresentationViewer, {
      fileName: "sample.pptx",
      preview: {
        slideCount: 1,
        renderer: "officecli",
        renderStatus: "cached",
        slides: [{ index: 1, text: "Intro", imageUrl: "media://local/slide-token" }],
      },
      onOpenExternal: () => {},
      onShowInFinder: () => {},
    }));
    expect(markup).toMatch(/Compatibility preview|兼容预览/);
    expect(markup).toContain("media://local/slide-token");
  });
});
