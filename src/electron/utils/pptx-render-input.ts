import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const namedColors = require("color-name") as Record<string, number[]>;

const child = (node: Element | undefined, name: string) => node && Array.from(node.childNodes)
  .find(item => item.nodeType === 1 && (item as Element).namespaceURI === DRAWING
    && (item as Element).localName === name) as Element | undefined;

function normalizeTextDefaults(document: Document): boolean {
  let changed = false;
  for (const body of Array.from(document.getElementsByTagName("*")).filter(node => node.localName === "txBody")) {
    const properties = child(body, "bodyPr");
    const autoFit = child(properties, "spAutoFit");
    if (autoFit && ["eaVert", "vert", "vert270", "wordArtVert", "wordArtVertRtl", "mongolianVert"].includes(properties!.getAttribute("vert") || "")) {
      // OfficeCLI grows vertical text along the wrong axis (height:auto),
      // turning a saved 114pt frame into a page-tall box. Render its saved
      // geometry; native translation fitting separately measures every glyph.
      properties!.replaceChild(document.createElementNS(DRAWING, "a:noAutofit"), autoFit);
      changed = true;
    }
    const bodyText = Array.from(body.getElementsByTagNameNS(DRAWING, "t")).map(node => node.textContent || "").join("");
    if (properties?.getAttribute("vert") === "eaVert" && /[A-Za-z]/.test(bodyText)
      && /^[\x00-\x7f\u00a0-\u024f\u2000-\u206f]*$/.test(bodyText)) {
      // ST_TextVerticalType eaVert rotates Latin runs, unlike stacked WordArt.
      // OfficeCLI maps it to CSS upright for every script. For Latin-only
      // bodies, its vert renderer provides the equivalent sideways layout.
      properties.setAttribute("vert", "vert");
      changed = true;
    }
    const list = child(body, "lstStyle");
    for (const paragraph of Array.from(body.childNodes).filter(node => node.nodeType === 1
      && (node as Element).namespaceURI === DRAWING && (node as Element).localName === "p") as Element[]) {
      const pPr = child(paragraph, "pPr");
      const level = Number(pPr?.getAttribute("lvl") || 0) + 1;
      const size = child(pPr, "defRPr")?.getAttribute("sz")
        || child(child(list, `lvl${level}pPr`), "defRPr")?.getAttribute("sz")
        || child(child(list, "defPPr"), "defRPr")?.getAttribute("sz");
      // OfficeCLI skips local list defaults and sizes its paragraph strut
      // before consulting defRPr. Make the inherited size explicit only in
      // this render copy; explicit run formatting always wins.
      if (size) for (const run of Array.from(paragraph.childNodes).filter(node => node.nodeType === 1
        && ["r", "fld"].includes((node as Element).localName)) as Element[]) {
        let rPr = child(run, "rPr");
        if (rPr?.hasAttribute("sz")) continue;
        if (!rPr) { rPr = document.createElementNS(DRAWING, "a:rPr"); run.insertBefore(rPr, run.firstChild); }
        rPr.setAttribute("sz", size);
        changed = true;
      }
      if (!child(paragraph, "r") && !child(paragraph, "fld")) {
        const emptySize = child(paragraph, "endParaRPr")?.getAttribute("sz") || size;
        if (emptySize) {
          const run = document.createElementNS(DRAWING, "a:r");
          const rPr = document.createElementNS(DRAWING, "a:rPr");
          rPr.setAttribute("sz", emptySize); run.appendChild(rPr);
          run.appendChild(document.createElementNS(DRAWING, "a:t"));
          paragraph.insertBefore(run, child(paragraph, "endParaRPr") || null);
          changed = true;
        }
      }
    }
  }
  return changed;
}

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
    if (!/\b(?:prstClr|sysClr|txBody)\b/.test(xml)) continue;
    const document = new DOMParser().parseFromString(xml, "application/xml");
    let partChanged = normalizeTextDefaults(document);
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
