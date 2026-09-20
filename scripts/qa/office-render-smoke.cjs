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
  const JSZip = require("jszip");
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
    for (const kind of ["plain", "large", "transparent-preset", "inline-math"]) {
      const large = kind === "large";
      const deck = new PptxGenJS();
      const slide = deck.addSlide();
      slide.addText("翻译检查", { x: 1, y: 1, w: 5, h: 1, fontSize: 20 });
      if (large) {
        const png = new PNG({ width: 3000, height: 3000 });
        png.data = randomBytes(3000 * 3000 * 4);
        const data = PNG.sync.write(png, { colorType: 2, inputColorType: 6 });
        slide.addImage({ data: "image/png;base64," + data.toString("base64"), x: 1, y: 3, w: 2, h: 2 });
      }
      let source = Buffer.from(await deck.write({ outputType: "nodebuffer" }));
      if (kind === "transparent-preset") {
        const zip = await JSZip.loadAsync(source);
        const xml = await zip.file("ppt/slides/slide1.xml").async("text");
        zip.file("ppt/slides/slide1.xml", xml.replace(/(<a:rPr[^>]*>)/, '$1<a:solidFill><a:prstClr val="white"><a:alpha val="50000"/></a:prstClr></a:solidFill>'));
        source = await zip.generateAsync({ type: "nodebuffer" });
      }
      if (kind === "inline-math") {
        const zip = await JSZip.loadAsync(source);
        const xml = await zip.file("ppt/slides/slide1.xml").async("text");
        const formula = '<a14:m xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>≈</m:t></m:r></m:oMath></a14:m>';
        zip.file("ppt/slides/slide1.xml", xml.replace('</a:r>', '</a:r>' + formula));
        source = await zip.generateAsync({ type: "nodebuffer" });
      }
      if (large) assert(source.length > 24 * 1024 * 1024, `Large fixture too small: ${source.length}`);
      const input = path.join(binDir, "原文件 candidate.pptx");
      const html = path.join(binDir, "候选预览.html");
      fs.writeFileSync(input, source);
      const start = Date.now();
      const render = spawnSync(copiedExe, ["view", input, "html", "-o", html, "--json"], {
        env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: "1" }, encoding: "utf8", timeout: 60_000, windowsHide: true,
      });
      console.log(JSON.stringify({ stage: "view-html", kind, bytes: source.length, ms: Date.now() - start,
        status: render.status, signal: render.signal, error: render.error?.message, stdout: render.stdout, stderr: render.stderr }));
      if (kind === "transparent-preset") {
        assert.notEqual(render.status, 0, "Pinned renderer should reproduce transparent preset failure");
        assert.match(render.stdout, /Could not find any recognizable digits/);
      } else {
        assert.equal(render.status, 0, "OfficeCLI view html failed");
        assert(fs.statSync(html).size > 0);
      }
      if (kind === "plain") {
        // Compare packaged-name and copied-name execution, including Windows
        // short temp paths, so a runtime assembly error is not misdiagnosed.
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "neoworker-office-path-"));
        const probe = path.join(temp, "candidate.pptx");
        fs.writeFileSync(probe, source);
        for (const probeInput of [input, probe, fs.realpathSync(probe)]) {
          const result = spawnSync(executable, ["view", probeInput, "html", "-o", html, "--json"], {
            env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: "1" }, encoding: "utf8", timeout: 60_000, windowsHide: true,
          });
          console.log(JSON.stringify({ stage: "runtime-path-probe", input: probeInput, code: result.status, stdout: result.stdout, stderr: result.stderr }));
        }
        fs.rmSync(temp, { recursive: true, force: true });
      }
      const manifest = await inspectOfficeTranslation(source);
      manifest.units.find(unit => unit.text === "翻译检查").text = "Translation check";
      const translated = await applyOfficeTranslation(source, manifest);
      const fitted = await fitPptxTranslation(source, translated, manifest);
      assert(fitted.output, JSON.stringify(fitted.issues));
      await verifyOfficeTranslationFidelity(source, fitted.output, true);
      console.log(JSON.stringify({ stage: "translation-fit", kind, checked: fitted.checkedShapes, ms: Date.now() - start }));
    }
    console.log("PASS: real Office HTML rendering and translation fitting, including >24 MiB PPTX and Chinese executable/file paths.");
  }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
