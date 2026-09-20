import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { resolveBundledOfficeCliExecutable } from "./officecli-runtime";
import { preparePptxRenderInput, describePptxRenderFailure } from "./pptx-render-input";
import type { TextFitBox, TextFitMeasurement } from "../documents/pptx-translation-layout";

// Runs in the isolated renderer against OfficeCLI's actual HTML, including its
// group transforms, inherited fonts, margins, bullets and line spacing.
async function measureInBrowser(boxes: TextFitBox[], allowShrink = true): Promise<TextFitMeasurement[]> {
  await document.fonts.ready;
  const style = document.createElement("style");
  style.textContent = ".slide{transform:none!important;display:block!important}.slide-container{display:block!important;height:auto!important}.main{display:block!important;overflow:visible!important}body{height:auto!important;overflow:visible!important}";
  document.head.appendChild(style);
  const normalize = (value: string) => value.replace(/\s|\u200b/g, "");
  const slides = Array.from(document.querySelectorAll<HTMLElement>(".main .slide"));
  const used = new Set<Element>();
  const tableStates = new Map<Element, { elements: HTMLElement[]; fonts: number[]; scale: number; minFont: number; keys: string[] }>();
  const results: TextFitMeasurement[] = [];
  const geometry = new Map<string, NonNullable<TextFitMeasurement["geometry"]>>();
  for (const box of boxes) {
    const slide = slides[box.slide - 1];
    const content = slide && Array.from(slide.querySelectorAll<HTMLElement>(box.kind === "table" ? ".slide-table td" : ".shape > .shape-text"))
      .find((element) => {
        if (used.has(element)) return false;
        const clone = element.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(".bullet").forEach((bullet) => bullet.remove());
        return normalize(clone.textContent || "") === normalize(box.text);
      });
    if (!content) { results.push({ key: box.key, scale: 1, fits: false, reason: "text_box_not_rendered" }); continue; }
    used.add(content);
    // Flexbox must not compress paragraph line boxes while leaving glyphs
    // overflowing them; PowerPoint lays out complete lines before autofitting.
    content.querySelectorAll<HTMLElement>(".para").forEach((paragraph) => { paragraph.style.flexShrink = "0"; });
    const shape = box.kind === "table" ? content : content.parentElement!;
    const shapeStyle = getComputedStyle(shape);
    const inset = (name: string) => parseFloat(shapeStyle.getPropertyValue(name)) || 0;
    let shapeRect = shape.getBoundingClientRect();
    const slideRect = slide.getBoundingClientRect();
    let bounds = {
      left: shapeRect.left + inset("padding-left"), top: shapeRect.top + inset("padding-top"),
      right: shapeRect.right - inset("padding-right"), bottom: shapeRect.bottom - inset("padding-bottom"),
    };
    const fontElements = [content, ...Array.from(content.querySelectorAll<HTMLElement>(".para, span"))];
    const fonts = fontElements.map((element) => parseFloat(getComputedStyle(element).fontSize));
    const textFonts = Array.from(content.querySelectorAll<HTMLElement>("span"))
      .filter((element) => element.textContent?.trim()).map((element) => parseFloat(getComputedStyle(element).fontSize));
    let minFont = Math.min(...(textFonts.length ? textFonts : fonts)) * 0.75;
    const table = box.kind === "table" ? content.closest("table") : null;
    const tableState = table ? tableStates.get(table) : undefined;
    const activeTableState = table
      ? (tableState || (() => {
        const elements = Array.from(table.querySelectorAll<HTMLElement>("td, td .para, td span"));
        const state = { elements, fonts: elements.map((element) => parseFloat(getComputedStyle(element).fontSize)), scale: 1, minFont: Math.min(...Array.from(table.querySelectorAll<HTMLElement>("td span")).filter((element) => element.textContent?.trim()).map((element) => parseFloat(getComputedStyle(element).fontSize))) * 0.75, keys: [] as string[] };
        tableStates.set(table, state);
        return state;
      })())
      : undefined;
    if (activeTableState) { activeTableState.keys.push(box.key); minFont = activeTableState.minFont; }
    // CJK source decks often use very compact labels. A direct German or
    // Japanese translation can need a little more room than the old 65%
    // floor allowed, even when the resulting native font is still readable.
    // Keep a hard lower bound so this remains a bounded autofit rather than
    // an unbounded shrink-to-zero fallback.
    const lowerBound = Math.min(1, Math.max(0.55, Math.min(8, Math.max(6, minFont * 0.8)) / minFont));
    const upperBound = activeTableState?.scale ?? 1;
    const scaleTo = (scale: number) => {
      if (activeTableState) {
        activeTableState.scale = scale;
        activeTableState.elements.forEach((element, index) => { element.style.fontSize = `${activeTableState.fonts[index] * scale}px`; });
      } else {
        fontElements.forEach((element, index) => { element.style.fontSize = `${fonts[index] * scale}px`; });
      }
    };
    // Chromium exposes hanging line-end spaces outside justified paragraphs.
    // Measure visible text runs without changing layout; whitespace has no ink.
    // Paragraph heights below still account for line breaks and blank lines.
    const textRanges: Range[] = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      for (const match of (walker.currentNode.textContent || "").matchAll(/[^\s\u200b]+/gu)) {
        const range = document.createRange();
        range.setStart(walker.currentNode, match.index!);
        range.setEnd(walker.currentNode, match.index! + match[0].length);
        textRanges.push(range);
      }
    }
    const inkRects = textRanges.flatMap(range => Array.from(range.getClientRects())).filter(rect => rect.width > 0.1 && rect.height > 0.1);
    if (inkRects.length) geometry.set(box.key, {
      frame: { left: shapeRect.left - slideRect.left, top: shapeRect.top - slideRect.top,
        right: shapeRect.right - slideRect.left, bottom: shapeRect.bottom - slideRect.top },
      ink: { left: Math.min(...inkRects.map(r => r.left)) - slideRect.left,
        top: Math.min(...inkRects.map(r => r.top)) - slideRect.top,
        right: Math.max(...inkRects.map(r => r.right)) - slideRect.left,
        bottom: Math.max(...inkRects.map(r => r.bottom)) - slideRect.top },
    });
    const safe = box.safeBounds;
    const visibleFrame = {
      left: Math.max(shapeRect.left, slideRect.left, safe ? slideRect.left + safe.left : -Infinity),
      right: Math.min(shapeRect.right, slideRect.right, safe ? slideRect.left + safe.right : Infinity),
      top: Math.max(shapeRect.top, slideRect.top, safe ? slideRect.top + safe.top : -Infinity),
      bottom: Math.min(shapeRect.bottom, slideRect.bottom, safe ? slideRect.top + safe.bottom : Infinity),
    };
    const fits = () => {
      if (activeTableState) {
        shapeRect = shape.getBoundingClientRect();
        bounds = { left: shapeRect.left + inset("padding-left"), top: shapeRect.top + inset("padding-top"),
          right: shapeRect.right - inset("padding-right"), bottom: shapeRect.bottom - inset("padding-bottom") };
      }
      if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return false;
      if (box.kind === "table") {
        const table = content.closest("table")!.getBoundingClientRect();
        const frame = content.closest(".table-container")?.getBoundingClientRect();
        // OfficeCLI wraps tables in a bordered container. Chromium reports the
        // table border-box about 2–3 px beyond that wrapper even when every
        // cell is inside its assigned row/column. Allow that renderer seam,
        // while still rejecting real row growth and slide-edge overflow.
        const tableFrameTolerance = 4;
        if (!frame || table.bottom > Math.min(frame.bottom, slideRect.bottom) + tableFrameTolerance
          || table.right > frame.right + tableFrameTolerance) return false;
      }
      for (const range of textRanges) {
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width < 0.1 || rect.height < 0.1) continue;
          // Font ascent/descent may extend slightly into padding (notably
          // Calibri fallback). Padding constrains line layout below; glyph ink
          // must remain inside the actual frame, not inside its padded inset.
          if (rect.left < visibleFrame.left - 2
            || rect.right > visibleFrame.right + 2
            || rect.top < visibleFrame.top - 2
            || rect.bottom > visibleFrame.bottom + 2) return false;
        }
      }
      // Range rectangles cover every non-whitespace glyph on every line.
      // Empty trailing paragraphs and font leading have no visible ink; their
      // line boxes can extend beyond a frame even when its text fits. Treating
      // that leading as visible overflow caused repeated, excessive shrinking.
      return true;
    };
    const overflow = () => {
      const value = { left: 0, right: 0, top: 0, bottom: 0, lines: 0 };
      for (const range of textRanges) for (const rect of Array.from(range.getClientRects())) {
        value.left = Math.max(value.left, visibleFrame.left - rect.left);
        value.right = Math.max(value.right, rect.right - visibleFrame.right);
        value.top = Math.max(value.top, visibleFrame.top - rect.top);
        value.bottom = Math.max(value.bottom, rect.bottom - visibleFrame.bottom);
      }
      value.lines = Math.max(0, Array.from(content.children).reduce((sum, element) => {
        const css = getComputedStyle(element);
        return sum + element.getBoundingClientRect().height + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
      }, 0) - (bounds.bottom - bounds.top));
      return value;
    };
    if (fits()) { results.push({ key: box.key, scale: 1, fits: true, minFontPt: minFont }); continue; }
    if (!allowShrink) {
      results.push({ key: box.key, scale: 1, fits: false, reason: "translation_too_long", minFontPt: minFont, overflow: overflow() }); continue;
    }
    scaleTo(lowerBound);
    if (!fits() || content.classList.contains("has-vert-text")) {
      results.push({ key: box.key, scale: lowerBound, fits: false, reason: "translation_too_long", minFontPt: minFont * lowerBound, overflow: overflow() }); continue;
    }
    let low = lowerBound; let high = upperBound;
    for (let iteration = 0; iteration < 12; iteration++) {
      const mid = (low + high) / 2; scaleTo(mid);
      if (fits()) low = mid; else high = mid;
    }
    // A small margin covers OOXML percentage rounding and font metric drift.
    let scale = Math.max(lowerBound, Math.floor((low - 0.01) * 10000) / 10000);
    scaleTo(scale);
    if (!fits()) { scale = lowerBound; scaleTo(scale); }
    const verified = fits();
    results.push({ key: box.key, scale, fits: verified, ...(verified ? {} : { reason: "translation_too_long" }), minFontPt: minFont * scale });
  }
  // Every cell in a table must use the same final scale measured for the table.
  for (const state of tableStates.values()) {
    for (const result of results) if (state.keys.includes(result.key)) result.scale = state.scale;
  }
  return results.map(result => ({ ...result, geometry: geometry.get(result.key) }));
}

export async function measurePptxTextFit(candidate: Buffer, boxes: TextFitBox[], options?: { allowShrink?: boolean }): Promise<TextFitMeasurement[]> {
  const executable = resolveBundledOfficeCliExecutable();
  if (!executable) throw new Error("无法检查译后版式：内置 Office 渲染器不可用。");
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-translation-fit-"));
  let window: import("electron").BrowserWindow | undefined;
  try {
    const sourcePath = path.join(staging, "candidate.pptx");
    const htmlPath = path.join(staging, "candidate.html");
    await fs.writeFile(sourcePath, await preparePptxRenderInput(candidate));
    try {
      await promisify(execFile)(executable, ["view", sourcePath, "html", "-o", htmlPath, "--json"], {
        timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: "1" },
      });
    } catch (error) {
      throw new Error(describePptxRenderFailure(error), { cause: error });
    }
    const { app, BrowserWindow } = await import("electron");
    await app.whenReady();
    window = new BrowserWindow({ show: false, width: 1800, height: 1400,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, partition: `translation-fit-${randomUUID()}` } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_, callback) => callback({ cancel: true }));
    await window.loadFile(htmlPath);
    return await window.webContents.executeJavaScript(`(${measureInBrowser.toString()})(${JSON.stringify(boxes)}, ${options?.allowShrink !== false})`);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await fs.rm(staging, { recursive: true, force: true });
  }
}
