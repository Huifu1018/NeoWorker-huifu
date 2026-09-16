import { useEffect, useRef, useState } from "react";
import { translate } from "../i18n";

const FRAME_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
html,body { margin:0; background:#f3f4f6; }
#pages { width:max-content; min-width:100%; }
.docx-wrapper { padding:20px !important; background:transparent !important; }
.docx-wrapper > section.docx { margin-bottom:20px; }
</style></head><body><div id="pages"></div></body></html>`;

export function DocxLayoutPreview({ dataBase64, zoom, onOpenExternal }: {
  dataBase64: string;
  zoom: number;
  onOpenExternal: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!frameDocument) return;
    let cancelled = false;
    setStatus("loading");
    const root = frameDocument.getElementById("pages")!;
    root.replaceChildren();
    delete root.dataset.ready;
    const styles = frameDocument.createElement("div");
    const pages = frameDocument.createElement("div");
    const timeout = window.setTimeout(() => {
      cancelled = true;
      root.replaceChildren();
      setStatus("error");
    }, 60_000);
    // Render off-DOM: a slow previous file must never replace a newer preview.
    void (async () => {
      const { renderAsync } = await import("docx-preview");
      const bytes = Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0));
      await renderAsync(bytes, pages, styles, {
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderAltChunks: false,
        useBase64URL: true,
      });
      if (cancelled) return;
      if (!pages.querySelector("section.docx")) throw new Error("No document pages");
      root.replaceChildren(styles, pages);
      await frameDocument.fonts.ready;
      if (cancelled) return;
      root.dataset.ready = "true";
      setStatus("ready");
    })().catch(() => {
      if (!cancelled) setStatus("error");
    }).finally(() => window.clearTimeout(timeout));
    const preventNavigation = (event: Event) => event.preventDefault();
    frameDocument.addEventListener("click", preventNavigation);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      frameDocument.removeEventListener("click", preventNavigation);
      root.replaceChildren();
    };
  }, [dataBase64, frameDocument]);

  useEffect(() => {
    const frame = frameRef.current;
    const root = frameDocument?.getElementById("pages");
    if (!frame || !root || status !== "ready") return;
    const updateZoom = () => {
      const pages = Array.from(root.querySelectorAll<HTMLElement>("section.docx"));
      const width = Math.max(1, ...pages.map((page) => page.offsetWidth)) + 40;
      const fit = Math.min(1, frame.clientWidth / width);
      root.style.zoom = String(fit * zoom);
    };
    updateZoom();
    const observer = new ResizeObserver(updateZoom);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameDocument, status, zoom]);

  return (
    <div className="docx-layout-preview" data-preview-status={status}>
      {status !== "ready" && (
        <div className="document-viewer-state" role="status">
          {status === "loading"
            ? translate("documentViewer.layoutLoading", "Loading document layout...")
            : translate("documentViewer.layoutFailed", "Document layout preview is unavailable.")}
          {status === "error" && (
            <button type="button" className="document-viewer-tool-btn" onClick={onOpenExternal}>
              {translate("documentViewer.openExternally", "Open externally")}
            </button>
          )}
        </div>
      )}
      <iframe
        ref={frameRef}
        title={translate("documentViewer.layoutPreview", "Document layout preview")}
        sandbox="allow-same-origin"
        srcDoc={FRAME_DOCUMENT}
        onLoad={() => setFrameDocument(frameRef.current?.contentDocument || null)}
        style={{ visibility: status === "ready" ? "visible" : "hidden" }}
      />
    </div>
  );
}
