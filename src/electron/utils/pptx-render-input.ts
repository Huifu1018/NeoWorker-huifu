import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const namedColors = require("color-name") as Record<string, number[]>;

/** OfficeCLI 1.0.143 parses transparent preset/system colors twice: rgba()
 * is passed to its hex parser and crashes. Use the equivalent sRGB encoding
 * only in the disposable rendering copy. Keep every color transform, including
 * alpha, and never use these bytes as the translated delivery document. */
export async function preparePptxRenderInput(source: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(source);
  let changed = false;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !name.startsWith("ppt/") || !name.endsWith(".xml")) continue;
    const xml = await entry.async("text");
    if (!/\b(?:prstClr|sysClr)\b/.test(xml)) continue;
    const document = new DOMParser().parseFromString(xml, "application/xml");
    let partChanged = false;
    const colors = [
      ...Array.from(document.getElementsByTagNameNS(DRAWING, "prstClr")),
      ...Array.from(document.getElementsByTagNameNS(DRAWING, "sysClr")),
    ];
    for (const color of colors) {
      const alpha = Array.from(color.childNodes).find(node => node.nodeType === 1
        && (node as Element).namespaceURI === DRAWING && (node as Element).localName === "alpha") as Element | undefined;
      if (!alpha || !/^\d+$/.test(alpha.getAttribute("val") || "") || Number(alpha.getAttribute("val")) >= 100000) continue;
      let hex: string | undefined;
      if (color.localName === "sysClr") {
        const last = color.getAttribute("lastClr") || "";
        if (/^[0-9a-f]{6}$/i.test(last)) hex = last.toUpperCase();
      } else {
        // DrawingML abbreviates dark/light/medium in preset color names.
        const name = (color.getAttribute("val") || "").replace(/^dk(?=[A-Z])/, "dark")
          .replace(/^lt(?=[A-Z])/, "light").replace(/^med(?=[A-Z])/, "medium").toLowerCase();
        const rgb = Object.hasOwn(namedColors, name) ? namedColors[name] : undefined;
        if (rgb) hex = rgb.map(value => value.toString(16).padStart(2, "0")).join("").toUpperCase();
      }
      if (!hex) continue; // Unknown colors must be diagnosed, never guessed.
      const replacement = document.createElementNS(DRAWING, color.prefix ? `${color.prefix}:srgbClr` : "srgbClr");
      replacement.setAttribute("val", hex);
      for (const child of Array.from(color.childNodes)) replacement.appendChild(child.cloneNode(true));
      color.parentNode!.replaceChild(replacement, color);
      partChanged = true;
    }
    if (partChanged) {
      zip.file(name, new XMLSerializer().serializeToString(document), {
        date: entry.date, comment: entry.comment, unixPermissions: entry.unixPermissions, dosPermissions: entry.dosPermissions,
      });
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : source;
}

export function describePptxRenderFailure(error: unknown): string {
  const details = error as { stdout?: string | Buffer; stderr?: string | Buffer; code?: string | number; killed?: boolean; message?: string };
  const stdout = String(details?.stdout || "").trim();
  let reason = "";
  try {
    const payload = JSON.parse(stdout);
    reason = payload.error?.error || payload.error?.message || payload.message || "";
  } catch { /* Non-JSON diagnostics use stderr below. */ }
  reason ||= String(details?.stderr || "").trim() || stdout || details?.message || "未知错误";
  return `Office 版式渲染失败${details?.killed ? "（进程被终止或超时）" : details?.code !== undefined ? `（退出码 ${details.code}）` : ""}：${reason.slice(0, 2000)}`;
}
