import { randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";
import { repairHiddenHtmlContent } from "../../shared/html-content-visibility";
import { WEB_PREVIEW_MIME_TYPES } from "./mime-types";

const previews = new Map<string, { url: string; close: () => void }>();
const MAX_PREVIEWS = 10;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A normal HTTP origin is required by browser APIs and remote resources that
 * require a Referer. Never proxy remote requests or forge their identity.
 * Each page gets its own origin so root-relative assets continue to work. */
export async function createExternalWebPreviewUrl(htmlPath: string): Promise<string> {
  const entry = await fs.realpath(htmlPath);
  if (!/\.html?$/i.test(entry) || !(await fs.stat(entry)).isFile()) {
    throw new Error("External web preview requires an HTML file");
  }
  const existing = previews.get(entry);
  if (existing) return existing.url;
  const baseDir = path.dirname(entry);
  const token = randomBytes(32).toString("hex");
  const cookie = `neoworker_preview_${token.slice(0, 12)}=${token}`;
  let origin = "";
  let idleTimer: NodeJS.Timeout;
  const close = () => {
    clearTimeout(idleTimer);
    server.close();
    server.closeAllConnections();
    previews.delete(entry);
  };
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, IDLE_TIMEOUT_MS);
    idleTimer.unref();
  };
  const server = http.createServer(async (request, response) => {
    const fail = (status: number, message: string) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(message);
    };
    // Reject DNS rebinding and cross-origin reads of local files.
    if (request.headers.host !== new URL(origin).host
      || (request.headers.origin && request.headers.origin !== origin)
      || (request.headers["sec-fetch-site"] && !["none", "same-origin"].includes(String(request.headers["sec-fetch-site"])))) {
      fail(403, "Forbidden"); return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") { fail(405, "Method not allowed"); return; }
    try {
      const url = new URL(request.url || "/", origin);
      // Exchange the unguessable launch URL for an HttpOnly cookie, keeping the
      // capability out of the Referer and supporting /assets/... and ES modules.
      if (url.pathname === `/${token}/`) {
        touch();
        response.writeHead(302, {
          "Set-Cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/`,
          Location: `/${encodeURIComponent(path.basename(entry))}`,
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        });
        response.end(); return;
      }
      if (!(request.headers.cookie || "").split(/;\s*/).includes(cookie)) { fail(403, "Open this page from NeoWorker"); return; }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!relative || relative.split(/[\\/]/).some((segment) => segment.startsWith(".")) || relative.includes("\0")) {
        fail(403, "Forbidden"); return;
      }
      const candidate = path.resolve(baseDir, relative);
      if (!inside(baseDir, candidate)) { fail(403, "Forbidden"); return; }
      const realPath = await fs.realpath(candidate);
      const mime = WEB_PREVIEW_MIME_TYPES[path.extname(realPath).toLowerCase()];
      if (!inside(baseDir, realPath) || !mime) { fail(403, "Forbidden"); return; }
      const stats = await fs.stat(realPath);
      if (!stats.isFile()) { fail(404, "Not found"); return; }
      let content = await fs.readFile(realPath);
      if (/\.html?$/i.test(realPath)) content = Buffer.from(repairHiddenHtmlContent(content.toString("utf8")).content);
      touch();
      response.writeHead(200, {
        "Content-Type": mime, "Content-Length": content.length,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // Send only the real page origin to remote resources, never local paths.
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      fail(error instanceof URIError ? 400 : 404, "Preview resource not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address() as import("net").AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  server.unref();
  const url = `${origin}/${token}/`;
  while (previews.size >= MAX_PREVIEWS) previews.values().next().value!.close();
  previews.set(entry, { url, close });
  touch();
  return url;
}

export function closeExternalWebPreviews(): void {
  for (const preview of previews.values()) preview.close();
}
