import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { extractPptxContentFromFile, extractPptxStructuredContentFromFile } from '../../src/electron/utils/pptx-extractor';

let tempDirs: string[] = [];

async function createTempPptx(slideXml: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neoworker-pptx-test-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'sample.pptx');
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slideXml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(filePath, buffer);
  return filePath;
}

describe('pptx-extractor', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it('extracts slide text from pptx files', async () => {
    const pptxPath = await createTempPptx(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>Hello from slide</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    const content = await extractPptxContentFromFile(pptxPath);
    expect(content).toContain('[PPTX Slides: 1]');
    expect(content).toContain('Hello from slide');
  });

  it('identifies picture components without presenting them as complete diagrams', async () => {
    const file = await createTempPptx(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="7" name="Plus"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId7"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="185040" cy="201600"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>`);
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="rId7" Target="../media/image7.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const text = await extractPptxContentFromFile(file);
    expect(text).toContain('Slide 1');
    expect(text).toContain('Image asset: Plus');
    expect(text).toContain('file image7.png');
    expect(text).toContain('shape-local size 0.20 x 0.22 in (before group transforms)');
    expect(text).toContain('not a rendered slide or verified complete diagram');
    expect(text).not.toContain('Image/Diagram');
  });

  it('preserves complete tables inside graphic frames and the text after them', async () => {
    const row = (cells: string[]) => `<a:tr>${cells.map(text => `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`;
    const file = await createTempPptx(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="110" name="Benchmark table"/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>${row(['Model', 'Active parameters', 'GFLOPS', 'HumanEval'])}${row(['Yuan2.0-M32', '3.7B', '7.4', '74.4'])}${row(['Llama3-70B', '70B', '140', '81.7'])}</a:tbl></a:graphicData></a:graphic></p:graphicFrame><p:sp><p:txBody><a:p><a:r><a:t>Following text must survive</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
    const text = await extractPptxContentFromFile(file);
    expect(text).toContain('| Model | Active parameters | GFLOPS | HumanEval |');
    expect(text).toContain('| Yuan2.0-M32 | 3.7B | 7.4 | 74.4 |');
    expect(text).toContain('| Llama3-70B | 70B | 140 | 81.7 |');
    expect(text).toContain('Following text must survive');
    expect(text).not.toContain('[Graphic - Benchmark table]');
  });

  it.each([false, true])('uses presentation order and ignores orphan parts with sections=%s', async (withSections) => {
    const slide = (text: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const file = await createTempPptx(slide('Orphan'));
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    zip.file('ppt/slides/slide3.xml', slide('Second'));
    zip.file('ppt/slides/slide5.xml', slide('First'));
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="first"/><p:sldId id="257" r:id="second"/></p:sldIdLst></p:presentation>');
    if (withSections) {
      const xml = await zip.file('ppt/presentation.xml')!.async('string');
      zip.file('ppt/presentation.xml', xml.replace('</p:presentation>', '<p:extLst><p:ext uri="section-list"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="Intro" id="section-1"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>'));
    }
    zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide5.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide3.xml"/></Relationships>');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await extractPptxStructuredContentFromFile(file);
    expect(result.slideCount).toBe(2);
    expect(result.slides.map(({ index, text }) => ({ index, text }))).toEqual([{ index: 1, text: 'First' }, { index: 2, text: 'Second' }]);
  });

  it('still rejects a missing slide referenced by the main slide list', async () => {
    const file = await createTempPptx('<slide/>');
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="missing"/></p:sldIdLst></p:presentation>');
    zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(extractPptxStructuredContentFromFile(file)).rejects.toThrow('Presentation references a missing slide');
  });

  it('applies output truncation limit when configured', async () => {
    const pptxPath = await createTempPptx(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>${'A'.repeat(500)}</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    const content = await extractPptxContentFromFile(pptxPath, { outputCharLimit: 120 });
    expect(content).toContain('[... Content truncated. Showing first');
  });
});
