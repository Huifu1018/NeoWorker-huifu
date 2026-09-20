import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { preparePptxRenderInput, describePptxRenderFailure } from "../pptx-render-input";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
async function fixture(color: string) {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", `<a:test xmlns:a="${A}"><a:t>Unchanged text</a:t>${color}</a:test>`);
  zip.file("ppt/media/image.png", Buffer.from([1, 2, 3, 4]));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("PPTX rendering compatibility", () => {
  it.each([
    ['<a:prstClr val="white"><a:alpha val="50000"/><a:shade val="75000"/></a:prstClr>', "FFFFFF"],
    ['<a:prstClr val="dkBlue"><a:alpha val="0"/></a:prstClr>', "00008B"],
    ['<a:prstClr val="medSeaGreen"><a:alpha val="30000"/></a:prstClr>', "3CB371"],
    ['<a:sysClr val="windowText" lastClr="Ab12Ef"><a:alpha val="10000"/></a:sysClr>', "AB12EF"],
  ])("converts %s to equivalent sRGB only in a separate rendering copy", async (color, rgb) => {
    const source = await fixture(color), before = Buffer.from(source);
    const rendered = await preparePptxRenderInput(source);
    expect(source.equals(before)).toBe(true);
    expect(rendered.equals(source)).toBe(false);
    const zip = await JSZip.loadAsync(rendered);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("text");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const converted = doc.getElementsByTagNameNS(A, "srgbClr")[0];
    expect(converted.getAttribute("val")).toBe(rgb);
    const original = new DOMParser().parseFromString(`<a:test xmlns:a="${A}">${color}</a:test>`, "application/xml");
    expect(converted.getElementsByTagNameNS(A, "alpha")[0].getAttribute("val"))
      .toBe(original.getElementsByTagNameNS(A, "alpha")[0].getAttribute("val"));
    if (color.includes("shade")) expect(converted.getElementsByTagNameNS(A, "shade")[0].getAttribute("val")).toBe("75000");
    expect(doc.getElementsByTagNameNS(A, "t")[0].textContent).toBe("Unchanged text");
    expect(await zip.file("ppt/media/image.png")!.async("nodebuffer")).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it.each([
    '<a:prstClr val="white"/>',
    '<a:prstClr val="white"><a:alpha val="100000"/></a:prstClr>',
    '<a:prstClr val="unrecognized"><a:alpha val="50000"/></a:prstClr>',
    '<a:sysClr val="windowText"><a:alpha val="50000"/></a:sysClr>',
    '<a:srgbClr val="FFFFFF"><a:alpha val="50000"/></a:srgbClr>',
  ])("preserves unsupported or unaffected color %s byte for byte", async color => {
    const source = await fixture(color);
    expect(await preparePptxRenderInput(source)).toBe(source);
  });

  it("resolves local font defaults and empty line metrics without overwriting explicit run sizes", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", `<p:txBody xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="${A}"><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="1000"/></a:lvl1pPr></a:lstStyle>
      <a:p><a:pPr/><a:r><a:rPr/><a:t>Inherited</a:t></a:r><a:r><a:rPr sz="1400"/><a:t>Explicit</a:t></a:r></a:p>
      <a:p><a:pPr><a:defRPr sz="1100"/></a:pPr><a:r><a:t>Paragraph</a:t></a:r></a:p>
      <a:p><a:pPr/><a:endParaRPr sz="1200"/></a:p></p:txBody>`);
    const source = await zip.generateAsync({ type: "nodebuffer" });
    const result = await JSZip.loadAsync(await preparePptxRenderInput(source));
    const doc = new DOMParser().parseFromString(await result.file("ppt/slides/slide1.xml")!.async("text"), "application/xml");
    expect(Array.from(doc.getElementsByTagNameNS(A, "rPr")).map(node => node.getAttribute("sz"))).toEqual(["1000", "1400", "1100", "1200"]);
    expect(await preparePptxRenderInput(await result.generateAsync({ type: "nodebuffer" }))).toBeInstanceOf(Buffer);
    expect((await JSZip.loadAsync(source)).file("ppt/slides/slide1.xml")).toBeTruthy();
  });
  it.each(["eaVert", "vert270"])("retains saved geometry for vertical %s instead of auto-growing the wrong axis", async vert => {
    const source = await fixture(`<a:txBody><a:bodyPr vert="${vert}"><a:spAutoFit/></a:bodyPr></a:txBody>`);
    const result = await JSZip.loadAsync(await preparePptxRenderInput(source));
    const xml = await result.file("ppt/slides/slide1.xml")!.async("text");
    expect(xml).toContain('a:noAutofit'); expect(xml).not.toContain('a:spAutoFit');
  });

  it("renders Latin East Asian vertical text sideways while retaining stacked WordArt and CJK", async () => {
    for (const [vert, text, expected] of [["eaVert", "Long-term memory", "vert"], ["eaVert", "长期记忆", "eaVert"], ["wordArtVert", "Memory", "wordArtVert"]]) {
      const source = await fixture(`<a:txBody><a:bodyPr vert="${vert}"/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody>`);
      const result = await JSZip.loadAsync(await preparePptxRenderInput(source));
      expect(await result.file("ppt/slides/slide1.xml")!.async("text")).toContain(`vert="${expected}"`);
    }
  });
  it("surfaces the actual structured stdout error instead of only Command failed", () => {
    const error = { code: 1, killed: false, message: "Command failed: officecli view ...",
      stdout: JSON.stringify({ success: false, error: { code: "internal_error", error: "Could not find any recognizable digits." } }), stderr: "" };
    expect(describePptxRenderFailure(error)).toBe("Office 版式渲染失败（退出码 1）：Could not find any recognizable digits.");
  });

  it("distinguishes killed processes from ordinary exit failures", () => {
    expect(describePptxRenderFailure({ killed: true, stderr: "render stopped" })).toContain("进程被终止或超时");
  });
});
