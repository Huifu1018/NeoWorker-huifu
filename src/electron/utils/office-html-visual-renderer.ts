import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import { containsOfficeMojibake } from "./office-font-resolver";

export interface OfficeHtmlVisualRenderInput {
  htmlPath: string;
  outputPath: string;
  maxPages?: number;
  timeoutMs?: number;
  textValidation?: "strict" | "warn";
}

export interface OfficeHtmlVisualRenderResult {
  evidencePath: string;
  pageCount: number;
  imagePaths: string[];
  renderer: "electron-chromium";
  textWarningPages?: number[];
}

export type OfficeHtmlVisualRenderer = (
  input: OfficeHtmlVisualRenderInput,
) => Promise<OfficeHtmlVisualRenderResult>;

interface VisualRegion {
  selector: string;
  index: number;
  captureSelector?: string;
  activate?: boolean;
}

interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
}

function buildEvidenceDirectory(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}-pages`);
}

function pageImageName(index: number): string {
  return `page-${String(index + 1).padStart(3, "0")}.png`;
}

export const renderOfficeHtmlVisualEvidence: OfficeHtmlVisualRenderer = async ({
  htmlPath,
  outputPath,
  maxPages,
  timeoutMs = 60_000,
  textValidation = "strict",
}) => {
  if (!process.versions.electron) {
    throw new Error("NeoWorker's embedded Chromium renderer is only available inside the desktop app.");
  }

  const { app, BrowserWindow, session } = await import("electron");
  if (!app.isReady()) await app.whenReady();

  const partition = `neoworker-office-visual-${randomUUID()}`;
  const isolatedSession = session.fromPartition(partition, { cache: false });
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const protocol = new URL(details.url).protocol;
      callback({ cancel: protocol === "http:" || protocol === "https:" });
    } catch {
      callback({ cancel: true });
    }
  });

  const window = new BrowserWindow({
    show: false,
    width: 1800,
    height: 1400,
    backgroundColor: "#ffffff",
    webPreferences: {
      session: isolatedSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== pathToFileURL(path.resolve(htmlPath)).toString()) event.preventDefault();
  });

  const timeout = setTimeout(() => {
    if (!window.isDestroyed()) window.destroy();
  }, timeoutMs);
  try {
    await window.loadURL(pathToFileURL(path.resolve(htmlPath)).toString());
    await window.webContents.insertCSS("* { scroll-behavior: auto !important; }");
    await window.webContents.executeJavaScript(
      "document.fonts ? document.fonts.ready.then(() => true) : true",
      true,
    );

    const documentText = await window.webContents.executeJavaScript(
      "document.body ? document.body.innerText : ''",
      true,
    );
    if (textValidation === "strict" && containsOfficeMojibake(String(documentText || ""))) {
      throw new Error("Rendered Office preview contains replacement or mojibake characters.");
    }

    const regions = (await window.webContents.executeJavaScript(`(() => {
      const thumbnails = Array.from(document.querySelectorAll(".thumb"));
      const visibleSlides = Array.from(document.querySelectorAll(".slide"));
      if (thumbnails.length > 1 && visibleSlides.length === 1) {
        return thumbnails.map((_node, index) => ({
          selector: ".thumb",
          captureSelector: ".slide",
          activate: true,
          index
        }));
      }
      const selectors = [".slide", ".page", "[data-page]", ".page-wrapper", "section"];
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector)).map((node, index) => ({ node, index })).filter(({ node }) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width >= 200 && rect.height >= 120 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (nodes.length) return nodes.map(({ index }) => ({ selector, index }));
      }
      return document.body ? [{ selector: "body", index: 0 }] : [];
    })()`, true)) as VisualRegion[];

    if (!regions.length) {
      throw new Error("The Office preview did not contain any renderable pages or slides.");
    }

    const evidenceDirectory = buildEvidenceDirectory(outputPath);
    await fs.mkdir(evidenceDirectory, { recursive: true });
    const imagePaths: string[] = [];
    const textWarningPages: number[] = [];
    let previousCapture: Buffer | undefined;
    let previousText: string | undefined;

    for (const region of regions.slice(0, maxPages)) {
      const rect = (await window.webContents.executeJavaScript(`(async () => {
        const activationNode = document.querySelectorAll(${JSON.stringify(region.selector)})[${region.index}];
        if (${Boolean(region.activate)} && activationNode) {
          activationNode.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        const node = ${region.captureSelector
          ? `document.querySelector(${JSON.stringify(region.captureSelector)})`
          : `activationNode`};
        if (!node) return null;
        await Promise.all(Array.from(node.querySelectorAll("img")).map((image) => image.decode().catch(() => {})));
        node.scrollIntoView({ block: "center", inline: "center" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bounds = node.getBoundingClientRect();
        return {
          text: node.innerText || '',
          x: Math.max(0, Math.floor(bounds.left)),
          y: Math.max(0, Math.floor(bounds.top)),
          width: Math.max(1, Math.min(window.innerWidth - Math.max(0, Math.floor(bounds.left)), Math.ceil(bounds.width))),
          height: Math.max(1, Math.min(window.innerHeight - Math.max(0, Math.floor(bounds.top)), Math.ceil(bounds.height)))
        };
      })()`, true)) as CaptureRect | null;
      if (!rect || rect.width < 1 || rect.height < 1) {
        throw new Error(`Page ${region.index + 1} could not be positioned for visual capture.`);
      }
      if (containsOfficeMojibake(rect.text || "")) {
        if (textValidation === "strict") throw new Error(`Page ${region.index + 1} contains replacement or mojibake characters.`);
        textWarningPages.push(region.index + 1);
      }
      let image = await window.webContents.capturePage(rect);
      let png = image.toPNG();
      // Hidden Chromium windows can briefly return the preceding compositor frame after scrolling.
      for (let retry = 0; retry < 3 && previousCapture?.equals(png) && rect.text !== previousText; retry++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        image = await window.webContents.capturePage(rect);
        png = image.toPNG();
      }
      if (image.isEmpty()) {
        throw new Error(`Page ${region.index + 1} produced an empty visual capture.`);
      }
      const imagePath = path.join(evidenceDirectory, pageImageName(imagePaths.length));
      await fs.writeFile(imagePath, png);
      imagePaths.push(imagePath);
      previousCapture = png;
      previousText = rect.text;
    }

    const evidencePath = path.join(evidenceDirectory, "evidence.json");
    await fs.writeFile(
      evidencePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          renderer: "electron-chromium",
          sourceHtml: path.resolve(htmlPath),
          createdAt: new Date().toISOString(),
          pageCount: imagePaths.length,
          textWarningPages,
          pages: imagePaths.map((imagePath, index) => ({
            page: index + 1,
            imagePath,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    return {
      evidencePath,
      pageCount: imagePaths.length,
      imagePaths,
      renderer: "electron-chromium",
      textWarningPages,
    };
  } finally {
    clearTimeout(timeout);
    if (!window.isDestroyed()) window.destroy();
  }
};
