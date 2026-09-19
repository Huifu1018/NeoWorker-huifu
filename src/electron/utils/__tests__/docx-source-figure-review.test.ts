import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { reviewDocxSourceFigures } from "../docx-source-figure-review";

const dirs: string[] = [];
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const media = Buffer.from("identical source and output image bytes");
async function fixture(options: { scale?: number; different?: boolean; missingTransform?: boolean; reusedLarge?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-figure-"));
  dirs.push(root);
  const docx = path.join(root, "report.docx");
  const pptx = path.join(root, "source.pptx");
  const output = new JSZip();
  output.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="${A}" xmlns:wp="${WP}" xmlns:r="${R}"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="5486400"/><a:blip r:embed="image"/></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`);
  output.file("word/_rels/document.xml.rels", '<Relationships><Relationship Id="image" Target="media/image.png"/></Relationships>');
  output.file("word/media/image.png", options.different ? Buffer.from("different") : media);
  const source = new JSZip();
  const picture = (size: number) => `<p:pic><p:blipFill><a:blip r:embed="image"/></p:blipFill><p:spPr><a:xfrm><a:ext cx="${size}" cy="${size}"/></a:xfrm></p:spPr></p:pic>`;
  const groupTransform = options.missingTransform ? '' : `<a:xfrm><a:ext cx="${1000000 * (options.scale || 1)}" cy="${1000000 * (options.scale || 1)}"/><a:chExt cx="1000000" cy="1000000"/></a:xfrm>`;
  source.file("ppt/slides/slide1.xml", `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:grpSp><p:grpSpPr>${groupTransform}</p:grpSpPr>${picture(180000)}</p:grpSp>${options.reusedLarge ? picture(5486400) : ''}</p:spTree></p:cSld></p:sld>`);
  source.file("ppt/slides/_rels/slide1.xml.rels", '<Relationships><Relationship Id="image" Target="../media/component.png"/></Relationships>');
  source.file("ppt/media/component.png", media);
  await fs.writeFile(docx, await output.generateAsync({ type: "nodebuffer" }));
  await fs.writeFile(pptx, await source.generateAsync({ type: "nodebuffer" }));
  return { docx, pptx };
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
describe("source figure identity and scale", () => {
  it("finds a byte-identical tiny component enlarged as a report figure", async () => {
    const { docx, pptx } = await fixture();
    const findings = await reviewDocxSourceFigures(docx, [pptx]);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("enlarged-source-component");
    expect(findings[0].message).toContain("slide1.xml");
    expect(findings[0].message).toContain("6.00 inches");
  });
  it.each([
    { scale: 30 }, { different: true }, { missingTransform: true }, { reusedLarge: true },
  ])("avoids unsupported component claims for %j", async (options) => {
    const { docx, pptx } = await fixture(options);
    expect(await reviewDocxSourceFigures(docx, [pptx])).toEqual([]);
  });
});
