// Exercise the bundled Office renderer and Electron text measurement without
// user files, external services or model calls. Run with Node on either OS.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-office-qa-"));
  const env = { ...process.env, NEOWORKER_OFFICE_QA_ROOT: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit", timeout: 300_000 });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} else {
  const { app } = require("electron");
  const { randomBytes } = require("node:crypto");
  const PptxGenJS = require("pptxgenjs");
  const { PNG } = require("pngjs");
  const { inspectOfficeTranslation, applyOfficeTranslation, verifyOfficeTranslationFidelity } = require("../../dist/electron/electron/documents/office-translation.js");
  const { fitPptxTranslation } = require("../../dist/electron/electron/documents/pptx-translation-layout.js");
  const { resolveBundledOfficeCliExecutable } = require("../../dist/electron/electron/utils/officecli-runtime.js");
  const root = process.env.NEOWORKER_OFFICE_QA_ROOT;
  app.setPath("userData", path.join(root, "profile"));
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    const executable = resolveBundledOfficeCliExecutable();
    assert(executable, "Bundled OfficeCLI missing");
    // Deliberately exercise the same executable from a Chinese path with spaces.
    const binDir = path.join(root, "中文 安装目录", "Office工具");
    fs.mkdirSync(binDir, { recursive: true });
    const copiedExe = path.join(binDir, process.platform === "win32" ? "Office工具.exe" : "Office工具");
    fs.copyFileSync(executable, copiedExe);
    fs.chmodSync(copiedExe, 0o755);
    for (const large of [false, true]) {
      const deck = new PptxGenJS();
      const slide = deck.addSlide();
      slide.addText("翻译检查", { x: 1, y: 1, w: 5, h: 1, fontSize: 20 });
      if (large) {
        const png = new PNG({ width: 2900, height: 2900 });
        png.data = randomBytes(2900 * 2900 * 4);
        const data = PNG.sync.write(png, { colorType: 2, inputColorType: 6 });
        slide.addImage({ data: "image/png;base64," + data.toString("base64"), x: 1, y: 3, w: 2, h: 2 });
      }
      const source = Buffer.from(await deck.write({ outputType: "nodebuffer" }));
      if (large) assert(source.length > 24 * 1024 * 1024, `Large fixture too small: ${source.length}`);
      const input = path.join(binDir, "原文件 candidate.pptx");
      const html = path.join(binDir, "候选预览.html");
      fs.writeFileSync(input, source);
      const start = Date.now();
      const render = spawnSync(copiedExe, ["view", input, "html", "-o", html, "--json"], {
        env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: "1" }, encoding: "utf8", timeout: 60_000, windowsHide: true,
      });
      console.log(JSON.stringify({ stage: "view-html", large, bytes: source.length, ms: Date.now() - start,
        status: render.status, signal: render.signal, error: render.error?.message, stdout: render.stdout, stderr: render.stderr }));
      assert.equal(render.status, 0, "OfficeCLI view html failed");
      assert(fs.statSync(html).size > 0);
      const manifest = await inspectOfficeTranslation(source);
      manifest.units.find(unit => unit.text === "翻译检查").text = "Translation check";
      const translated = await applyOfficeTranslation(source, manifest);
      const fitted = await fitPptxTranslation(source, translated, manifest);
      assert(fitted.output, JSON.stringify(fitted.issues));
      await verifyOfficeTranslationFidelity(source, fitted.output, true);
      console.log(JSON.stringify({ stage: "translation-fit", large, checked: fitted.checkedShapes, ms: Date.now() - start }));
    }
    console.log("PASS: real Office HTML rendering and translation fitting, including >24 MiB PPTX and Chinese executable/file paths.");
  }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
