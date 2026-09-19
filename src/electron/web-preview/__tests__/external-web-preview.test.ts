import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { closeExternalWebPreviews, createExternalWebPreviewUrl } from "../external-web-preview";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "neoworker-external-preview-")); });
afterEach(async () => { closeExternalWebPreviews(); await fs.rm(root, { recursive: true, force: true }); });
async function launch() {
  await fs.mkdir(path.join(root, "site", "assets"), { recursive: true });
  const file = path.join(root, "site", "东京.html");
  await fs.writeFile(file, '<!doctype html><script type="module" src="/assets/app.js"></script><p>Map</p>');
  await fs.writeFile(path.join(root, "site", "assets", "app.js"), 'export const ok = true;');
  const url = await createExternalWebPreviewUrl(file);
  const bootstrap = await fetch(url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
  return { file, url, origin: new URL(url).origin, bootstrap, cookie };
}
describe("external HTML preview", () => {
  it("opens Unicode pages on HTTP with root-relative modules and a real origin Referer policy", async () => {
    const { file, url, origin, bootstrap, cookie } = await launch();
    expect(bootstrap.status).toBe(302);
    expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(await createExternalWebPreviewUrl(file)).toBe(url);
    const page = await fetch(origin + bootstrap.headers.get("location"), { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(await page.text()).toContain("Map");
    const asset = await fetch(origin + "/assets/app.js", { headers: { cookie } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("export const ok");
    const head = await fetch(origin + "/assets/app.js", { method: "HEAD", headers: { cookie } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
  it("blocks unauthenticated, cross-origin, hidden-file, traversal, symlink and write requests", async () => {
    const { origin, cookie } = await launch();
    await fs.writeFile(path.join(root, "secret.txt"), "private");
    await fs.writeFile(path.join(root, "site", ".secret.json"), "private");
    await fs.symlink(path.join(root, "secret.txt"), path.join(root, "site", "escape.txt"));
    for (const resource of ["/.secret.json", "/..%2Fsecret.txt", "/escape.txt"]) {
      expect((await fetch(origin + resource, { headers: { cookie } })).status).toBe(403);
    }
    expect((await fetch(origin + "/assets/app.js")).status).toBe(403);
    expect((await fetch(origin + "/assets/app.js", { headers: { cookie, origin: "https://example.org" } })).status).toBe(403);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      http.get(origin + "/assets/app.js", { headers: { cookie, host: "attacker.invalid" } }, (response) => {
        response.resume(); resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(rebound).toBe(403);
    expect((await fetch(origin + "/assets/app.js", { method: "POST", headers: { cookie } })).status).toBe(405);
    expect((await fetch(origin + "/%zz", { headers: { cookie } })).status).toBe(400);
  });
  it("isolates pages with different asset roots and closes servers on shutdown", async () => {
    const first = await launch();
    const secondFile = path.join(root, "second.html");
    await fs.writeFile(secondFile, "<p>Second</p>");
    const secondUrl = await createExternalWebPreviewUrl(secondFile);
    expect(new URL(secondUrl).origin).not.toBe(first.origin);
    closeExternalWebPreviews();
    await expect(fetch(secondUrl)).rejects.toThrow();
  });
});
