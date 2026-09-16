import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PptxGenJS from "pptxgenjs";

const root = await mkdtemp(path.join(os.tmpdir(), "neoworker-template-qa-"));
const image = path.join(root, "source.png");
await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAE/wJ/l2BNWAAAAABJRU5ErkJggg==", "base64"));
let source = process.argv[2];
if (!source) {
  source = path.join(root, "template(2).pptx");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.defineSlideMaster({ title: "BRANDED", background: { color: "FFFFFF" }, objects: [
    { rect: { x: 0, y: 0, w: 0.15, h: 7.5, fill: { color: "E93340" }, line: { color: "E93340" } } },
  ] });
  const cover = pptx.addSlide("BRANDED");
  cover.addText("Template cover", { x: 0.7, y: 1, w: 11, h: 1, fontSize: 40 });
  cover.addText("Template subtitle", { x: 0.7, y: 3, w: 11, h: 1, fontSize: 20 });
  const body = pptx.addSlide("BRANDED");
  body.addText("Template heading", { x: 0.7, y: 0.2, w: 11, h: 1, fontSize: 28 });
  body.addText(Array.from({ length: 6 }, (_, i) => `Sample paragraph ${i}: reusable native body formatting and content`).join("\n"), {
    x: 0.7, y: 1.5, w: 11, h: 5, fontSize: 18,
  });
  await pptx.writeFile({ fileName: source });
}
const slides = process.argv[3] ? JSON.parse(await readFile(process.argv[3], "utf8")) : [
  { slideType: "cover", title: "Template regression", subtitle: "Native master retained" },
  ...Array.from({ length: 4 }, (_, i) => ({ title: `Content ${i + 1}`, content: [`Evidence ${i + 1}`, "No content is dropped"], imagePath: image })),
];
const slidesPath = path.join(root, "slides.json");
const output = path.join(root, "result.pptx");
await writeFile(slidesPath, JSON.stringify(slides));
const adapter = path.resolve("resources/skills/ppt-master/scripts/neoworker_template_fill.py");
const python = process.env.NEOWORKER_PYTHON || "python3";
execFileSync(python, [adapter, "--source", source, "--slides-json", slidesPath, "--project", path.join(root, "project"), "--output", output], { timeout: 120000, stdio: "pipe" });
const report = JSON.parse(execFileSync(python, ["-c", `
import sys,json,zipfile,hashlib
from pathlib import Path
from xml.etree import ElementTree as ET
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from template_fill_pptx.ooxml import NS, _parse_slide_refs
source, output, slides_file = map(Path,sys.argv[2:])
slides=json.loads(slides_file.read_text())
with zipfile.ZipFile(source) as src, zipfile.ZipFile(output) as out:
    refs=_parse_slide_refs(out)
    assert len(refs)==len(slides)
    preserved=[]
    for name in out.namelist():
        if name.startswith(('ppt/slideMasters/','ppt/slideLayouts/','ppt/theme/')) and name in src.namelist():
            assert out.read(name)==src.read(name), name
            preserved.append(name)
    assert any(name.startswith('ppt/slideMasters/') for name in preserved)
    media={hashlib.sha256(out.read(name)).hexdigest() for name in out.namelist() if name.startswith('ppt/media/')}
    images=0
    for ref, slide in zip(refs,slides):
        tree=ET.fromstring(out.read(ref.part_name))
        text='\\n'.join(node.text or '' for node in tree.findall('.//a:t',NS))
        for value in [slide.get('title'),slide.get('subtitle'),*(slide.get('content') or [])]:
            if value: assert value in text, (ref.index,value)
        if slide.get('imagePath'):
            assert hashlib.sha256(Path(slide['imagePath']).read_bytes()).hexdigest() in media
            assert tree.findall('.//p:pic',NS)
            images+=1
print(json.dumps({'slides':len(refs),'requestedImages':images,'unchangedTemplateParts':len(preserved)}))
`, adapter, source, output, slidesPath], { encoding: "utf8" }));
assert.equal(report.slides, slides.length);
const failedOutput = path.join(root, "must-not-publish.pptx");
const invalidSlides = [{ title: "Missing image must fail", content: ["Body"], imagePath: path.join(root, "missing.png") }];
const invalidPath = path.join(root, "invalid.json");
await writeFile(invalidPath, JSON.stringify(invalidSlides));
assert.throws(() => execFileSync(python, [adapter, "--source", source, "--slides-json", invalidPath, "--project", path.join(root, "failed-project"), "--output", failedOutput], { timeout: 120000, stdio: "pipe" }));
await assert.rejects(stat(failedOutput), { code: "ENOENT" });
console.log(JSON.stringify({ ...report, output, root }, null, 2));
